// Delegated tasks: opencode_start / status / result / cancel / list. One `opencode run` per attempt, in its own process group.
use crate::config::*;
use crate::policy::*;
use crate::util::*;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct Failure { pub kind: String, pub message: String, pub advice: String, pub transient: bool }

pub struct Task {
    pub id: String, pub status: String, pub started: i64, pub ended: Option<i64>,
    pub text: String, pub text_truncated: bool, pub errors: Vec<String>, pub err: String,
    pub attempts: u32, pub resume: Option<String>, pub session_id: Option<String>,
    pub mode: String, pub agent: String, pub tier: String, pub title: String,
    pub args: Vec<String>, pub cwd: String, pub tmpdir: Option<String>,
    pub timeout_ms: u64, pub failure: Option<Failure>,
    pub pid: Option<u32>, pub exited: bool, pub timed_out: bool, pub finalized: bool, pub retry_at: i64, pub gen: u64,
}
pub type TaskRef = Arc<Mutex<Task>>;

fn registry() -> &'static Mutex<Vec<TaskRef>> { static R: OnceLock<Mutex<Vec<TaskRef>>> = OnceLock::new(); R.get_or_init(|| Mutex::new(Vec::new())) }
pub fn all_tasks() -> Vec<TaskRef> { registry().lock().unwrap().clone() }
fn live(t: &Task) -> bool { t.status == "running" || t.status == "retrying" }
fn running_tasks() -> Vec<TaskRef> { all_tasks().into_iter().filter(|t| live(&t.lock().unwrap())).collect() }

fn kill_group(t: &Task, sig: i32) {
    if let Some(pid) = t.pid {
        if t.exited { return; }
        unsafe { if libc::kill(-(pid as i32), sig) != 0 { libc::kill(pid as i32, sig); } }
    }
}
fn cleanup_tmp(t: &mut Task) { if let Some(d) = t.tmpdir.take() { let _ = std::fs::remove_dir_all(d); } }

fn sig_name(s: i32) -> String { match s { 1 => "SIGHUP".into(), 2 => "SIGINT".into(), 9 => "SIGKILL".into(), 15 => "SIGTERM".into(), n => format!("signal {}", n) } }

fn spawn_failure(e: &std::io::Error) -> Failure {
    if e.kind() == std::io::ErrorKind::NotFound {
        Failure { kind: "spawn".into(), message: "the opencode binary was not found on PATH".into(), advice: "Install opencode (>= 2) and make sure the process that runs the bridge has it on PATH.".into(), transient: false }
    } else if e.raw_os_error() == Some(libc::E2BIG) {
        Failure { kind: "spawn".into(), message: "argument list too long".into(), advice: "The prompt did not fit on the command line (it is normally attached as a file automatically).".into(), transient: false }
    } else {
        Failure { kind: "spawn".into(), message: clip(&e.to_string(), 300), advice: String::new(), transient: false }
    }
}

fn launch(tr: &TaskRef) {
    let (args, cwd, gen, timeout_ms) = {
        let mut t = tr.lock().unwrap();
        t.attempts += 1; t.gen += 1; t.text.clear(); t.text_truncated = false; t.errors.clear(); t.err.clear();
        t.timed_out = false; t.failure = None; t.session_id = t.resume.clone(); t.pid = None; t.exited = false; t.finalized = false;
        (t.args.clone(), t.cwd.clone(), t.gen, t.timeout_ms)
    };
    let spawned = Command::new("opencode").args(&args).current_dir(&cwd).env("PWD", &cwd).env("OPENCODE_CONFIG_CONTENT", WORKER_CONFIG)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0).spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => { finalize(tr, gen, None, None, Some(spawn_failure(&e))); return; }
    };
    tr.lock().unwrap().pid = Some(child.id());
    let so = child.stdout.take().unwrap();
    let se = child.stderr.take().unwrap();
    let (dtx, drx) = mpsc::channel::<()>();
    { // stdout: JSON events
        let tr2 = tr.clone(); let dtx = dtx.clone();
        std::thread::spawn(move || {
            let mut rd = BufReader::new(so); let mut line = Vec::new();
            loop {
                line.clear();
                match rd.read_until(b'\n', &mut line) { Ok(0) | Err(_) => break, Ok(_) => {} }
                let s = String::from_utf8_lossy(&line).trim_end_matches(['\n', '\r']).to_string();
                let j: Value = match serde_json::from_str(&s) { Ok(v) => v, Err(_) => continue };
                if !j.is_object() { continue; }
                let mut t = tr2.lock().unwrap();
                if t.gen != gen { continue; }
                if t.session_id.is_none() { if let Some(sid) = j["sessionID"].as_str().filter(|x| !x.is_empty()) { t.session_id = Some(sid.to_string()); } }
                match j["type"].as_str() {
                    Some("text") => { let p = j["part"]["text"].as_str().unwrap_or(""); t.text.push_str(p); if chars_len(&t.text) > MAX_TEXT { keep_last_chars(&mut t.text, MAX_TEXT); t.text_truncated = true; } }
                    Some("error") if t.errors.len() < 20 => {
                        let src = if !j["error"].is_null() { &j["error"] } else if !j["message"].is_null() { &j["message"] } else { &j };
                        t.errors.push(err_text(src));
                    }
                    _ => {}
                }
            }
            let _ = dtx.send(());
        });
    }
    { // stderr: keep the last 4000 characters
        let tr2 = tr.clone(); let dtx = dtx.clone();
        std::thread::spawn(move || {
            let mut se = se; let mut chunk = vec![0u8; 8192];
            loop {
                match se.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => { let mut t = tr2.lock().unwrap(); if t.gen == gen { t.err.push_str(&String::from_utf8_lossy(&chunk[..n])); keep_last_chars(&mut t.err, 4000); } }
                }
            }
            let _ = dtx.send(());
        });
    }
    drop(dtx);
    { // wall-clock limit: SIGTERM to the group, SIGKILL after the grace period
        let tr2 = tr.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_millis(timeout_ms);
            loop {
                std::thread::sleep(Duration::from_millis(20));
                { let t = tr2.lock().unwrap(); if t.gen != gen || t.exited || t.finalized || !live(&t) { return; } }
                if Instant::now() >= deadline { break; }
            }
            { let mut t = tr2.lock().unwrap(); if t.gen != gen || t.exited { return; } t.timed_out = true; kill_group(&t, libc::SIGTERM); }
            std::thread::sleep(Duration::from_millis(cfg().kill_grace_ms));
            { let t = tr2.lock().unwrap(); if t.gen == gen && !t.exited { kill_group(&t, libc::SIGKILL); } }
        });
    }
    { // waiter: exit status, then (briefly) the readers, then finalize. A grandchild holding the pipes must not block us.
        let tr2 = tr.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            { let mut t = tr2.lock().unwrap(); if t.gen == gen { t.exited = true; } }
            let end = Instant::now() + Duration::from_millis(2000);
            for _ in 0..2 { let left = end.saturating_duration_since(Instant::now()); if drx.recv_timeout(left).is_err() { break; } }
            let (code, sig) = match status { Ok(s) => (s.code(), s.signal()), Err(_) => (None, None) };
            finalize(&tr2, gen, code, sig, None);
        });
    }
}

fn finalize(tr: &TaskRef, gen: u64, code: Option<i32>, sig: Option<i32>, spawn_err: Option<Failure>) {
    let mut t = tr.lock().unwrap();
    if t.gen != gen || t.finalized { return; }
    t.finalized = true;
    if t.status == "cancelled" { cleanup_tmp(&mut t); if t.ended.is_none() { t.ended = Some(now_ms()); } return; }
    let failure: Option<Failure> = if let Some(f) = spawn_err { Some(f) }
    else if t.timed_out {
        let m = if t.timeout_ms >= 60000 { format!("{} min", js_round(t.timeout_ms as f64 / 60000.0)) } else { format!("{} ms", t.timeout_ms) };
        Some(Failure { kind: "timeout".into(), message: format!("no result after {}; the process group was killed", m), advice: "Split the task into smaller pieces or raise timeout_minutes / OPENCODE_BRIDGE_TIMEOUT_MIN. Any partial output is in opencode_result.".into(), transient: false })
    } else if code != Some(0) || (!t.errors.is_empty() && t.text.is_empty()) {
        let last_err = t.err.trim().lines().filter(|l| !l.is_empty()).last().map(|s| s.to_string());
        let msg = t.errors.first().cloned().filter(|s| !s.is_empty()).or(last_err)
            .unwrap_or_else(|| match sig { Some(s) => format!("killed by signal {}", sig_name(s)), None => format!("exit code {}", code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())) });
        let c = classify(&format!("{} {}", t.errors.join(" "), t.err));
        let kind = if c.kind == "other" { if sig.is_some() { "signal".to_string() } else { "exit".to_string() } } else { c.kind.clone() };
        Some(Failure { kind, message: clip(&msg, 400), advice: c.advice, transient: c.transient })
    } else { None };
    let failure = match failure {
        None => { t.status = "done".into(); t.ended = Some(now_ms()); cleanup_tmp(&mut t); return; }
        Some(f) => f,
    };
    t.failure = Some(failure.clone());
    // Retry only what is safe to replay: transient errors of READ-ONLY agents that produced no output yet.
    if failure.transient && is_read_only(&t.agent) && t.text.is_empty() && t.attempts <= cfg().max_retries {
        let delay = cfg().retry_delay_ms * 3u64.pow(t.attempts - 1);
        t.status = "retrying".into(); t.retry_at = now_ms() + delay as i64;
        let tr2 = tr.clone(); let g = t.gen;
        drop(t);
        std::thread::spawn(move || {
            let end = Instant::now() + Duration::from_millis(delay);
            while Instant::now() < end {
                std::thread::sleep(Duration::from_millis(20));
                let t = tr2.lock().unwrap(); if t.gen != g || t.status != "retrying" { return; }
            }
            { let mut t = tr2.lock().unwrap(); if t.gen != g || t.status != "retrying" { return; } t.status = "running".into(); }
            launch(&tr2);
        });
        return;
    }
    t.status = if failure.kind == "timeout" { "timeout".into() } else { "failed".into() };
    t.ended = Some(now_ms()); cleanup_tmp(&mut t);
}

fn make_title(lane: Option<&str>, agent: &str, prompt: &str, cwd: &str) -> String {
    let base = std::path::Path::new(cwd).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let l0 = lane.filter(|s| !s.is_empty()).map(|s| s.to_string()).unwrap_or(if base.is_empty() { "BRIDGE".into() } else { base });
    let mut l = String::new(); let mut in_bad = false;
    for c in l0.to_uppercase().chars() {
        if c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-' { l.push(c); in_bad = false; }
        else if !in_bad { l.push('-'); in_bad = true; }
    }
    let first = prompt.lines().map(|x| x.trim()).find(|x| !x.is_empty() && !{ let lw = x.to_lowercase(); lw.starts_with("rule:") || lw.starts_with("rules:") }).unwrap_or("task");
    clean_title(&format!("{}/{}: {}", l, agent, clip(first, 60)))
}

pub fn start(a: &Value) -> Result<String, String> {
    let c = cfg();
    let prompt = arg_str(a, "prompt").map(|s| s.trim().to_string()).unwrap_or_default();
    if prompt.is_empty() { return Err("prompt is empty: pass the full task (context, absolute paths, desired output, test command)".into()); }
    if prompt.len() > PROMPT_MAX { return Err(format!("prompt is too large (> {} MB): put the material in files inside the working directory and reference their paths", PROMPT_MAX / 1_000_000)); }
    let cwd = resolve_cwd(&arg_str(a, "cwd").filter(|s| !s.is_empty()).unwrap_or_else(|| c.root.clone()))?;
    let tier = arg_str(a, "tier").map(|s| s.trim().to_lowercase());
    let model = arg_str(a, "model").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| c.model.clone());
    let det = detect_mode(&cwd, arg_str(a, "mode").map(|s| s.trim().to_string()).as_deref())?;
    let agent = arg_str(a, "agent").map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty())
        .unwrap_or_else(|| if det.mode == "sensitive" { "explorer".into() } else { std::env::var("OPENCODE_BRIDGE_AGENT").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "worker".into()) });
    let mechanical = matches!(a.get("mechanical"), Some(Value::Bool(true))) || matches!(a.get("mechanical"), Some(Value::String(s)) if s == "true");
    check_delegation(&agent, tier.as_deref(), mechanical, &prompt, &det.mode)?;
    let tier = tier.unwrap_or_default();
    let session_arg = arg_str(a, "session").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let mut resume: Option<String> = None;
    if let Some(sid) = &session_arg {
        let prev = all_tasks().into_iter().find(|t| t.lock().unwrap().id == *sid);
        match prev {
            None => return Err(format!("session continuation: unknown task id \"{}\" (opencode_list shows this bridge's tasks)", sid)),
            Some(p) => {
                resume = p.lock().unwrap().session_id.clone();
                if resume.is_none() { return Err("session continuation: that task has no session id yet (still starting, or it failed before a session was created)".into()); }
            }
        }
    }
    let running = running_tasks();
    if running.len() >= c.max_parallel {
        let list = running.iter().map(|r| { let r = r.lock().unwrap(); format!("{} {} \"{}\"", r.id, r.agent, clip(&r.title, 40)) }).collect::<Vec<_>>().join("; ");
        return Err(format!("parallel limit reached ({}/{} tasks running or waiting to retry): {}. Wait for one to finish (opencode_status), cancel one (opencode_cancel), or raise OPENCODE_BRIDGE_MAX_PARALLEL.", running.len(), c.max_parallel, list));
    }
    let id = format!("{:08x}", rand_u32());
    let final_title = { let t = clean_title(&arg_str(a, "title").unwrap_or_default()); if t.is_empty() { make_title(arg_str(a, "lane").as_deref(), &agent, &prompt, &cwd) } else { t } };
    let mut args: Vec<String> = ["run", "--standalone", "--agent"].iter().map(|s| s.to_string()).collect();
    args.push(agent.clone());
    for s in ["--auto", "--format", "json"] { args.push(s.into()); }
    if !model.is_empty() { args.push("-m".into()); args.push(model.clone()); }
    if let Some(r) = &resume { args.push("-s".into()); args.push(r.clone()); } else { args.push("--title".into()); args.push(final_title.clone()); }
    let full = format!("{}\n{}\n\n{}", guard_for(&agent), agent_rule(&agent), prompt);
    let mut message = full.clone(); let mut tmp: Option<String> = None;
    if full.len() > ARG_LIMIT { // one argument is limited to ~128 KiB: attach the task as a file instead
        let dir = format!("{}/ocb-{:08x}{:08x}", std::env::temp_dir().to_string_lossy(), std::process::id(), rand_u32());
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create temp dir: {}", e))?;
        { use std::os::unix::fs::{OpenOptionsExt, PermissionsExt}; use std::io::Write;
          let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
          let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(format!("{}/task.md", dir)).map_err(|e| format!("cannot write the prompt file: {}", e))?;
          f.write_all(full.as_bytes()).map_err(|e| format!("cannot write the prompt file: {}", e))?; }
        args.push("-f".into()); args.push(format!("{}/task.md", dir));
        message = format!("{}\n{}\n\nThe complete task is in the attached file task.md. Read it first and follow it exactly.", guard_for(&agent), agent_rule(&agent));
        tmp = Some(dir);
    }
    args.push(message);
    let timeout_min = num(a.get("timeout_minutes"), c.default_timeout_min, 1.0, 1440.0);
    let timeout_ms = (timeout_min * c.timeout_unit_ms as f64) as u64;
    let task = Task { id: id.clone(), status: "running".into(), started: now_ms(), ended: None, text: String::new(), text_truncated: false, errors: vec![], err: String::new(),
        attempts: 0, resume, session_id: None, mode: det.mode.clone(), agent: agent.clone(), tier: tier.clone(), title: final_title.clone(), args, cwd, tmpdir: tmp.clone(),
        timeout_ms, failure: None, pid: None, exited: false, timed_out: false, finalized: false, retry_at: 0, gen: 0 };
    let tr: TaskRef = Arc::new(Mutex::new(task));
    registry().lock().unwrap().push(tr.clone());
    prune();
    launch(&tr);
    let hint = if det.mode == "blueprint" && is_editor(&agent) { " Blueprint mode: make sure the prompt is a written Blueprint (files, signatures, acceptance criteria, test command)." }
        else if det.mode == "insensitive" { " Insensitive mode: prefer parallel lanes (several tasks at once)." } else { "" };
    let lim = format!("Limits: {}/{} parallel, timeout {} min{}{}.", running_tasks().len(), c.max_parallel, timeout_min,
        if is_read_only(&agent) { format!(", up to {} automatic retries of transient provider errors", c.max_retries) } else { ", no automatic retry (editing agent)".to_string() },
        if tmp.is_some() { format!(", prompt {} KB sent as an attached file", js_round(full.len() as f64 / 1024.0)) } else { String::new() });
    Ok(format!("task {} started | mode={} ({}) agent={} tier={} | title: {}\nNext: opencode_status / opencode_result (or opencode_session_output on the session id). {} {}{}",
        id, det.mode, det.source, agent, tier, final_title, lim, txt("verifyRule"), hint))
}

fn rand_u32() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    static CTR: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos() as u64 ^ d.as_secs()).unwrap_or(0);
    let c = CTR.fetch_add(0x9E37_79B9, std::sync::atomic::Ordering::Relaxed) as u64;
    let mut x = n.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (c << 7) ^ std::process::id() as u64;
    x ^= x >> 33; x = x.wrapping_mul(0xFF51_AFD7_ED55_8CCD); x ^= x >> 33;
    x as u32
}

fn prune() {
    let mut reg = registry().lock().unwrap();
    let mut fin: Vec<(i64, String)> = reg.iter().filter_map(|t| { let t = t.lock().unwrap(); t.ended.map(|e| (e, t.id.clone())) }).collect();
    fin.sort();
    if fin.len() > KEEP_FINISHED {
        let drop_ids: Vec<String> = fin[..fin.len() - KEEP_FINISHED].iter().map(|x| x.1.clone()).collect();
        reg.retain(|t| !drop_ids.contains(&t.lock().unwrap().id));
    }
}

pub fn get(id: &Value) -> Result<TaskRef, String> {
    let sid = match id { Value::String(s) => s.clone(), Value::Null => String::new(), o => o.to_string() };
    all_tasks().into_iter().find(|t| t.lock().unwrap().id == sid).ok_or_else(|| "unknown task (opencode_list shows this bridge's tasks; for any other session use opencode_sessions)".to_string())
}

fn el(t: &Task) -> i64 { js_round(((t.ended.unwrap_or_else(now_ms)) - t.started) as f64 / 1000.0) }

pub fn status_text(t: &Task) -> String {
    format!("{}{}{} ({}s, {} chars{}{}) {}/{}/{}{}", t.status,
        t.failure.as_ref().map(|f| format!(" ({})", f.kind)).unwrap_or_default(),
        if t.status == "retrying" { format!(" in {}s", std::cmp::max(0, js_round((t.retry_at - now_ms()) as f64 / 1000.0))) } else { String::new() },
        el(t), chars_len(&t.text), t.session_id.as_ref().map(|s| format!(", session {}", s)).unwrap_or_default(),
        if t.attempts > 1 { format!(", attempt {}", t.attempts) } else { String::new() }, t.agent, t.tier, t.mode,
        if t.status == "done" && !t.errors.is_empty() { format!(" [{} error event(s) during the run]", t.errors.len()) } else { String::new() })
}

pub fn result_text(t: &Task, a: &Value) -> String {
    let mut lines = vec![format!("[{}{}]", t.status, t.failure.as_ref().map(|f| format!(": {}", f.kind)).unwrap_or_default())];
    if let Some(f) = &t.failure { lines.push(f.message.clone()); if !f.advice.is_empty() { lines.push(format!("Advice: {}", f.advice)); } }
    if t.status == "retrying" { lines.push(format!("waiting {}s before attempt {} of {}", std::cmp::max(0, js_round((t.retry_at - now_ms()) as f64 / 1000.0)), t.attempts + 1, cfg().max_retries + 1)); }
    if t.failure.is_none() && !t.errors.is_empty() { lines.push(format!("warning: {} error event(s) during the run, first: {}", t.errors.len(), clip(&t.errors[0], 200))); }
    if t.text_truncated { lines.push(format!("note: the output exceeded {} MB; only the last {} MB are kept", MAX_TEXT / 1_000_000, MAX_TEXT / 1_000_000)); }
    let mut body = if !t.text.is_empty() { t.text.clone() } else if t.failure.is_some() || t.status == "cancelled" { String::new() } else { "(no output yet)".to_string() };
    let tail_n = num(a.get("tail"), 0.0, 0.0, 5e7) as usize; let head_n = num(a.get("head"), 0.0, 0.0, 5e7) as usize;
    let blen = chars_len(&body);
    if tail_n > 0 && blen > tail_n { body = last_chars(&body, tail_n); }
    else if head_n > 0 && blen > head_n { body = first_chars(&body, head_n); }
    else if tail_n == 0 && head_n == 0 && blen > RESULT_CAP {
        lines.push(format!("note: {} earlier characters omitted (output is {}); pass head=N for the beginning or tail=N for a different size", blen - RESULT_CAP, blen));
        body = last_chars(&body, RESULT_CAP);
    }
    if t.failure.is_some() && !body.is_empty() { lines.push("--- partial output ---".into()); }
    let mut out = lines.join("\n");
    if !body.is_empty() { out.push('\n'); out.push_str(&body); }
    out
}

pub fn cancel(tr: &TaskRef) -> String {
    let mut t = tr.lock().unwrap();
    if !live(&t) { return format!("task already {}; nothing to cancel", t.status); }
    let was_retrying = t.status == "retrying";
    t.status = "cancelled".into(); t.ended = Some(now_ms());
    if !was_retrying {
        kill_group(&t, libc::SIGTERM);
        let (tr2, g) = (tr.clone(), t.gen);
        std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(cfg().kill_grace_ms)); let t = tr2.lock().unwrap(); if t.gen == g && !t.exited { kill_group(&t, libc::SIGKILL); } });
    } else { cleanup_tmp(&mut t); }
    "cancelled".into()
}

pub fn list_text() -> String {
    let rows: Vec<String> = all_tasks().iter().map(|t| { let t = t.lock().unwrap();
        format!("{} {}{} {}s{} {}/{}/{} {}", t.id, t.status, t.failure.as_ref().map(|f| format!(":{}", f.kind)).unwrap_or_default(), el(&t),
            t.session_id.as_ref().map(|s| format!(" {}", s)).unwrap_or_default(), t.agent, t.tier, t.mode, clip(&t.title, 60)) }).collect();
    if rows.is_empty() { "none".into() } else { rows.join("\n") }
}

/// Client gone / SIGTERM: stop every run (and its children) and remove temp files.
pub fn shutdown_all() {
    let tasks = all_tasks();
    for tr in &tasks { let t = tr.lock().unwrap(); if live(&t) { kill_group(&t, libc::SIGTERM); } }
    std::thread::sleep(Duration::from_millis(300));
    for tr in &tasks { let mut t = tr.lock().unwrap(); kill_group(&t, libc::SIGKILL); cleanup_tmp(&mut t); }
}
