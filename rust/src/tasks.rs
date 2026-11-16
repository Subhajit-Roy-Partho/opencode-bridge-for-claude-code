// Delegated tasks: opencode_start / status / result / cancel / resume / list.
// v0.6: tasks are persistent and detached (docs/STATE.md). The bridge creates the task
// directory and task.json, spawns a detached runner (runner.rs), and reads snapshots
// from the files. One tool call never blocks longer than the call budget (main.rs).
use crate::config::*;
use crate::policy::*;
use crate::state::*;
use crate::svc::*;
use crate::util::*;
use serde_json::{json, Value};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub struct Snapshot {
    pub t: Value,
    pub ev: Ev,
    pub status: String,
    pub text: String,
    pub note: String,
}

fn live_status(s: &str) -> bool { !is_final_status(s) }
fn live_snap(s: &Snapshot) -> bool { live_status(&s.status) }

fn elapsed_of(t: &Value) -> i64 {
    let ended = t.get("ended").and_then(|v| v.as_i64()).unwrap_or_else(now_ms);
    let started = t.get("started").and_then(|v| v.as_i64()).unwrap_or(0);
    js_round((ended - started) as f64 / 1000.0)
}

fn is_true(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(true)) => true,
        Some(Value::String(s)) => s == "true",
        _ => false,
    }
}

fn truthy_arg(a: &Value, key: &str) -> bool { is_true(a.get(key)) }

fn last_start() -> &'static Mutex<i64> {
    static L: OnceLock<Mutex<i64>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(0))
}

fn inside_root(dir: &str) -> bool {
    match std::fs::canonicalize(dir) {
        Ok(p) => { let r = p.to_string_lossy().to_string(); r == cfg().root || r.starts_with(&format!("{}/", cfg().root)) }
        Err(_) => false,
    }
}

fn make_title(lane: Option<&str>, agent: &str, prompt: &str, cwd: &str) -> String {
    let base = std::path::Path::new(cwd).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let l0 = lane.filter(|s| !s.is_empty()).map(|s| s.to_string()).unwrap_or(if base.is_empty() { "BRIDGE".into() } else { base });
    let mut l = String::new();
    for c in l0.to_uppercase().chars() {
        if c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-' { l.push(c); }
        else if !l.ends_with('-') { l.push('-'); }
    }
    let first = prompt.lines().map(|x| x.trim()).find(|x| !x.is_empty() && !x.to_lowercase().starts_with("rule:") && !x.to_lowercase().starts_with("rules:")).unwrap_or("task");
    clean_title(&format!("{}/{}: {}", l, agent, clip(first, 60)))
}

fn rand_hex4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    static CTR: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos() as u64 ^ d.as_secs()).unwrap_or(0);
    let c = CTR.fetch_add(0x9E37_79B9, std::sync::atomic::Ordering::Relaxed) as u64;
    let mut x = n.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (c << 7) ^ std::process::id() as u64;
    x ^= x >> 33; x = x.wrapping_mul(0xFF51_AFD7_ED55_8CCD); x ^= x >> 33;
    format!("{:08x}", (x & 0xffffffff) as u32)
}

pub struct StartOut { pub id: String, pub text: String }

pub fn start(a: &Value, resume: Option<(&str, &str)>) -> Result<StartOut, String> {
    let c = cfg();
    let prompt = arg_str(a, "prompt").map(|s| s.trim().to_string()).unwrap_or_default();
    if prompt.is_empty() { return Err("prompt is empty: pass the full task (context, absolute paths, desired output, test command)".into()); }
    if prompt.len() > PROMPT_MAX { return Err(format!("prompt is too large (> {} MB): put the material in files inside the working directory and reference their paths", PROMPT_MAX as f64 / 1e6)); }
    let cwd_arg = arg_str(a, "cwd").filter(|s| !s.is_empty()).unwrap_or_else(|| c.root.clone());
    let cwd = resolve_cwd(&cwd_arg)?;
    let tier = arg_str(a, "tier").map(|s| s.trim().to_lowercase());
    let model = arg_str(a, "model").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| c.model.clone());
    let det = detect_mode(&cwd, arg_str(a, "mode").map(|s| s.trim().to_string()).as_deref())?;
    let agent = arg_str(a, "agent").map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty())
        .unwrap_or_else(|| if det.mode == "sensitive" { "explorer".into() } else { std::env::var("OPENCODE_BRIDGE_AGENT").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "worker".into()) });
    let mechanical = truthy_arg(a, "mechanical");
    let user_prompt = resume.map(|r| r.1.to_string()).unwrap_or_else(|| prompt.clone());
    check_delegation(&agent, tier.as_deref(), mechanical, &user_prompt, &det.mode)?;
    let tier = tier.unwrap_or_default();
    let session_arg = arg_str(a, "session").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let mut prev_session: Option<String> = None;
    if let Some(sid) = &session_arg {
        if sid.starts_with("ses_") && sid.len() > 4 && sid.chars().skip(4).all(|ch| ch.is_ascii_alphanumeric()) {
            prev_session = Some(sid.clone());
        } else {
            match read_task(&Value::String(sid.clone())) {
                None => return Err(format!("session continuation: unknown task id \"{}\" (opencode_list shows this bridge's tasks)", sid)),
                Some(prev) => {
                    let mut ps = prev.get("sessionID").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
                    if ps.is_none() {
                        let att = prev.get("attempt").and_then(|v| v.as_i64()).unwrap_or(0);
                        ps = read_events(&prev.get("id").and_then(|v| v.as_str()).unwrap_or(""), att).session_id;
                    }
                    match ps {
                        Some(s) => prev_session = Some(s),
                        None => return Err("session continuation: that task has no session id yet (still starting, or it failed before a session was created)".into()),
                    }
                }
            }
        }
    }
    let running = live_tasks();
    if running.len() >= c.max_parallel {
        let list = running.iter().map(|r| format!("{} {} \"{}\"", r.get("id").and_then(|v| v.as_str()).unwrap_or(""), r.get("agent").and_then(|v| v.as_str()).unwrap_or(""), clip(r.get("title").and_then(|v| v.as_str()).unwrap_or(""), 40))).collect::<Vec<_>>().join("; ");
        return Err(format!("parallel limit reached ({}/{} tasks running or waiting to retry): {}. Wait for one to finish (opencode_status), cancel one (opencode_cancel), or raise OPENCODE_BRIDGE_MAX_PARALLEL.", running.len(), c.max_parallel, list));
    }
    let id = rand_hex4();
    let lane = arg_str(a, "lane");
    let final_title = { let t = clean_title(&arg_str(a, "title").unwrap_or_default()); if t.is_empty() { make_title(lane.as_deref(), &agent, &user_prompt, &cwd) } else { t } };
    let backend = if c.backend == "auto" { if agent == "worker" { "standalone" } else { "service" } } else { c.backend.as_str() };
    let mut head: Vec<String> = vec!["run".into()];
    if backend == "standalone" { head.push("--standalone".into()); }
    head.push("--agent".into()); head.push(agent.clone());
    for s in ["--auto", "--format", "json"] { head.push(s.into()); }
    if !model.is_empty() { head.push("-m".into()); head.push(model.clone()); }
    let full = format!("{}\n{}\n\n{}", guard_for(&agent), agent_rule(&agent), prompt);
    let mut message = full.clone();
    let (mut attach_dir, mut attach_file): (Value, Value) = (Value::Null, Value::Null);
    ensure_state();
    if full.len() > ARG_LIMIT {
        let dir = format!("{}/ocb-{}-{}", std::env::temp_dir().to_string_lossy(), std::process::id(), rand_hex4());
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create temp dir: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        write_file_600(&format!("{}/task.md", dir), full.as_bytes());
        attach_dir = json!(dir.clone());
        attach_file = json!(format!("{}/task.md", dir));
        message = format!("{}\n{}\n\nThe complete task is in the attached file task.md. Read it first and follow it exactly.", guard_for(&agent), agent_rule(&agent));
    }
    let timeout_min = num(a.get("timeout_minutes"), c.default_timeout_min, 1.0, 1440.0);
    let timeout_ms = (timeout_min * c.timeout_unit_ms as f64) as u64;
    let started = { let mut l = last_start().lock().unwrap(); *l = std::cmp::max(now_ms(), *l + 1); *l };
    let mut t = json!({"v": 1, "id": id, "status": "running", "started": started, "deadline": started + timeout_ms as i64,
        "timeoutMin": timeout_min, "timeoutMs": timeout_ms, "mode": det.mode, "agent": agent, "tier": tier,
        "title": final_title, "cwd": cwd, "model": model, "backend": backend,
        "head": head, "message": message, "attachDir": attach_dir, "attachFile": attach_file,
        "maxRetries": c.max_retries, "retryDelayMs": c.retry_delay_ms, "attempt": 0, "failure": Value::Null,
        "bridge": pid_ref(std::process::id()), "mechanical": mechanical, "lane": lane.map(Value::String).unwrap_or(Value::Null)});
    if let Some(ps) = &prev_session { t["resumeSession"] = json!(ps); }
    if let Some((of, _)) = resume { t["resumeOf"] = json!(of); }
    std::fs::create_dir_all(tdir(&id)).map_err(|e| format!("cannot create task dir: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(tdir(&id), std::fs::Permissions::from_mode(0o700));
    }
    write_file_600(&format!("{}/prompt.md", tdir(&id)), user_prompt.as_bytes());
    write_task(&t);
    spawn_runner(&t);
    let hint = if det.mode == "blueprint" && is_editor(&agent) { " Blueprint mode: make sure the prompt is a written Blueprint (files, signatures, acceptance criteria, test command)." }
        else if det.mode == "insensitive" { " Insensitive mode: prefer parallel lanes (several tasks at once)." } else { "" };
    let lim = format!("Limits: {}/{} parallel, timeout {} min{}{}.", running.len() + 1, c.max_parallel, timeout_min,
        if is_read_only(&agent) { format!(", up to {} automatic retries of transient provider errors", c.max_retries) } else { ", no automatic retry (editing agent)".to_string() },
        if !attach_file.is_null() { format!(", prompt {} KB sent as an attached file", js_round(full.len() as f64 / 1024.0)) } else { String::new() });
    Ok(StartOut { id: id.clone(), text: format!("task {} started | mode={} ({}) agent={} tier={} | title: {}\nNext: opencode_status / opencode_result with wait_s (up to {} s per call), or opencode_session_output on the session id. The run is detached: it survives a restart of this bridge or of Claude Code (state in {}). {} {}{}", id, det.mode, det.source, agent, tier, final_title, c.max_wait_s, state_dir(), lim, txt("verifyRule"), hint) })
}

fn spawn_runner(t: &Value) {
    let id = t.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let dir = tdir(&id);
    let log = format!("{}/runner.log", dir);
    let exe = match std::env::current_exe() { Ok(p) => p, Err(e) => { fail_start(t, None, &e.to_string()); return; } };
    let mut cmd = Command::new(exe);
    cmd.args(["--runner", &dir]).stdin(Stdio::null()).current_dir(&dir).envs(std::env::vars()).process_group(0);
    match std::fs::OpenOptions::new().create(true).append(true).open(&log) {
        Ok(f) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&log, std::fs::Permissions::from_mode(0o600));
            }
            let f2 = std::fs::OpenOptions::new().create(true).append(true).open(&log).unwrap_or_else(|_| f.try_clone().expect("clone log"));
            cmd.stdout(Stdio::from(f)).stderr(Stdio::from(f2));
        }
        Err(_) => { cmd.stdout(Stdio::null()).stderr(Stdio::null()); }
    }
    match cmd.spawn() {
        Ok(child) => {
            atomic_write(&format!("{}/runner.json", dir), &serde_json::to_string(&pid_ref(child.id())).unwrap());
        }
        Err(e) => {
            let code = e.raw_os_error().map(|n| if n == libc::ENOENT { "ENOENT" } else if n == libc::E2BIG { "E2BIG" } else { "" });
            fail_start(t, code, &e.to_string());
        }
    }
}

fn fail_start(t: &Value, code: Option<&str>, msg: &str) {
    let mut cur = read_task(&t["id"]).unwrap_or_else(|| t.clone());
    cur["status"] = json!("failed");
    cur["failure"] = spawn_failure(code, msg);
    cur["ended"] = json!(now_ms());
    write_task(&cur);
}

pub fn live_tasks() -> Vec<Value> {
    let me = std::process::id();
    let mut v: Vec<Value> = registry().into_iter().filter(|t| {
        let st = t.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if !live_status(st) { return false; }
        let has_runner_field = t.get("runner").map(|r| !r.is_null()).unwrap_or(false);
        let runner_up = pid_alive(&t.get("runner").cloned().unwrap_or(Value::Null));
        let child_up = pid_alive(&t.get("child").cloned().unwrap_or(Value::Null));
        let started = t.get("started").and_then(|v| v.as_i64()).unwrap_or(0);
        if !(runner_up || child_up || (!has_runner_field && now_ms() - started < 15000)) { return false; }
        let bridge_pid = t.get("bridge").and_then(|v| v.get("pid")).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        bridge_pid == me || !pid_alive(&t.get("bridge").cloned().unwrap_or(Value::Null))
    }).collect();
    v.sort_by_key(|t| t.get("started").and_then(|v| v.as_i64()).unwrap_or(0));
    v
}

fn git_status(cwd: &str) -> String {
    match std::process::Command::new("git").args(["-C", cwd, "status", "--short"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).output() {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() { "(clean: no changes)".into() } else { s }
        }
        _ => "(not a git repository, or git is unavailable: check the files yourself)".into(),
    }
}

/// Snapshot of a task: the record, its events, and liveness notes.
pub fn snap(id: &str) -> Result<Snapshot, String> {
    let unknown = || "unknown task (opencode_list shows this bridge's tasks; for any other session use opencode_sessions)".to_string();
    let mut t = read_task(&Value::String(id.to_string())).ok_or_else(unknown)?;
    if !inside_root(t.get("cwd").and_then(|v| v.as_str()).unwrap_or("")) { return Err(unknown()); }
    let attempt = t.get("attempt").and_then(|v| v.as_i64()).unwrap_or(0);
    let ev = read_events(id, attempt);
    let mut status = t.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut note = String::new();
    if live_status(&status) {
        let runner_up = pid_alive(&t.get("runner").cloned().unwrap_or(Value::Null));
        let child_up = pid_alive(&t.get("child").cloned().unwrap_or(Value::Null));
        let has_runner = t.get("runner").map(|r| !r.is_null()).unwrap_or(false);
        let started = t.get("started").and_then(|v| v.as_i64()).unwrap_or(0);
        if runner_up {
            /* supervised */
        } else if !has_runner && now_ms() - started < 15000 {
            /* the runner is starting */
        } else if child_up {
            note = "supervisor process gone, the run continues".into();
            let deadline = t.get("deadline").and_then(|v| v.as_i64()).unwrap_or(i64::MAX);
            if now_ms() > deadline {
                kill_ref(&t.get("child").cloned().unwrap_or(Value::Null), libc::SIGTERM);
                let child = t.get("child").cloned().unwrap_or(Value::Null);
                std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(cfg().kill_grace_ms)); kill_ref(&child, libc::SIGKILL); });
            }
        } else {
            // The runner writes its final state BEFORE it exits: re-read once seen dead.
            if let Some(fresh) = read_task(&Value::String(id.to_string())) {
                if is_final_status(fresh.get("status").and_then(|v| v.as_str()).unwrap_or("")) {
                    t = fresh;
                    status = t.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string();
                } else if let Some(patch) = reconcile(&t, &ev) {
                    merge(&mut t, &patch);
                    status = t.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string();
                } else {
                    note = "the opencode service could not be asked about this session".into();
                }
            } else if let Some(patch) = reconcile(&t, &ev) {
                merge(&mut t, &patch);
                status = t.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string();
            } else {
                note = "the opencode service could not be asked about this session".into();
            }
        }
    }
    let rfile = format!("{}/result.txt", tdir(id));
    let text = if std::path::Path::new(&rfile).exists() { std::fs::read_to_string(&rfile).unwrap_or_default() } else { ev.text.clone() };
    Ok(Snapshot { t, ev, status, text, note })
}

fn merge(t: &mut Value, patch: &Value) {
    if let (Value::Object(tm), Value::Object(pm)) = (t, patch) {
        for (k, v) in pm { tm.insert(k.clone(), v.clone()); }
    }
}

/// The runner is gone and so is its client, without a final record: ask the service.
fn reconcile(t: &Value, ev: &Ev) -> Option<Value> {
    let id = t.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let done = |status: &str, failure: Option<Value>, extra: Value| -> Value {
        let cur = read_task(&Value::String(id.clone()));
        if let Some(c) = &cur {
            if is_final_status(c.get("status").and_then(|v| v.as_str()).unwrap_or("")) { return c.clone(); }
        }
        let mut n = cur.unwrap_or_else(|| t.clone());
        n["status"] = json!(status);
        n["failure"] = failure.unwrap_or(Value::Null);
        n["ended"] = json!(now_ms());
        n["retryAt"] = Value::Null;
        merge(&mut n, &extra);
        write_task(&n);
        n
    };
    if std::path::Path::new(&format!("{}/cancelled", tdir(&id))).exists() {
        return Some(done("cancelled", None, json!({})));
    }
    let timeout_ms = t.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(0);
    if now_ms() > t.get("deadline").and_then(|v| v.as_i64()).unwrap_or(i64::MAX) {
        return Some(done("timeout", Some(json!({"kind": "timeout", "message": format!("no result after {} s; the supervisor was gone", js_round(timeout_ms as f64 / 1000.0)), "advice": "Split the task into smaller pieces or raise timeout_minutes. Partial output is in opencode_result.", "transient": false})), json!({})));
    }
    let sid = ev.session_id.clone().or_else(|| t.get("sessionID").and_then(|v| v.as_str()).map(|s| s.to_string()));
    let sid = match sid { Some(s) => s, None => {
        return Some(done("lost", Some(json!({"kind": "lost", "message": "the run ended before opencode created a session (the supervisor and the client are gone); nothing can be recovered", "advice": "Start the task again (opencode_start with the same prompt; opencode_resume re-sends it).", "transient": false})), json!({})));
    }};
    let (s, act) = match session_state(&sid) {
        Ok(v) => v,
        Err(e) => {
            if regex::Regex::new(r"404|not found").unwrap().is_match(&e) {
                return Some(done("lost", Some(json!({"kind": "lost", "message": format!("session {} no longer exists in the service", sid), "advice": "Start the task again (opencode_resume re-sends it).", "transient": false})), json!({})));
            }
            return None;
        }
    };
    let s = s.unwrap_or(Value::Null);
    let upd = s.get("time").and_then(|v| v.get("updated")).and_then(|v| v.as_i64())
        .or_else(|| s.get("time").and_then(|v| v.get("created")).and_then(|v| v.as_i64())).unwrap_or(0);
    if act || (s.get("outcome").and_then(|v| v.as_str()).filter(|o| !o.is_empty()).is_none() && now_ms() - upd < cfg().reattach_quiet_ms) {
        let mut n = t.clone();
        n["sessionID"] = json!(sid);
        n["status"] = json!("running");
        return Some(n);
    }
    match s.get("outcome").and_then(|v| v.as_str()).unwrap_or("") {
        "succeeded" => {
            let mut text = String::new();
            if let Ok(m) = crate::api::api("GET", &format!("/api/session/{}/message", enc_component(&sid)), &[("limit", "40".to_string())], None) {
                let data: Vec<Value> = m.get("data").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                text = last_assistant_text(&data);
            }
            if !text.is_empty() { write_file_600(&format!("{}/result.txt", tdir(&id)), text.as_bytes()); }
            Some(done("done", None, json!({"sessionID": sid, "reconciled": true})))
        }
        "failed" => {
            let mut msg = String::new();
            if let Ok(m) = crate::api::api("GET", &format!("/api/session/{}/message", enc_component(&sid)), &[("limit", "40".to_string())], None) {
                let data: Vec<Value> = m.get("data").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                if let Some(e) = data.iter().map(|x| &x["error"]).find(|e| !e.is_null()) { msg = err_text(e); }
            }
            let cc = classify(&msg);
            let msg_txt = if msg.is_empty() { "the session failed".to_string() } else { msg.clone() };
            Some(done("failed", Some(json!({"kind": if cc.kind == "other" { "exit".to_string() } else { cc.kind }, "message": clip(&msg_txt, 400), "advice": cc.advice, "transient": cc.transient})), json!({"sessionID": sid, "reconciled": true})))
        }
        "interrupted" => Some(done("interrupted", Some(json!({"kind": "interrupted", "message": "the session was interrupted in the service", "advice": INTERRUPTED_ADVICE, "transient": false})), json!({"sessionID": sid, "reconciled": true}))),
        _ => Some(done("interrupted", Some(json!({"kind": "interrupted", "message": "the run ended without an outcome (client and supervisor gone, the service is not running the session)", "advice": INTERRUPTED_ADVICE, "transient": false})), json!({"sessionID": sid, "reconciled": true}))),
    }
}

fn age_s(ms: i64) -> Option<i64> { if ms != 0 { Some(std::cmp::max(0, js_round((now_ms() - ms) as f64 / 1000.0))) } else { None } }

fn progress_line(s: &Snapshot) -> String {
    let mut bits = vec![format!("{}s elapsed", elapsed_of(&s.t))];
    if s.ev.steps != 0 { bits.push(format!("{} step(s)", s.ev.steps)); }
    if s.ev.tokens_in != 0.0 || s.ev.tokens_out != 0.0 { bits.push(format!("{}/{} tok", k(s.ev.tokens_in), k(s.ev.tokens_out))); }
    if let Some(last) = s.ev.tools.last() { bits.push(format!("last tool {}({})", last.name, clip(&last.input, 60))); }
    if let Some(a) = age_s(s.ev.last_at) { bits.push(format!("last output {}s ago", a)); }
    if !s.text.is_empty() { bits.push(format!("{} chars of text", chars_len(&s.text))); }
    bits.join(", ")
}

fn stale_note(s: &Snapshot) -> String {
    let q = if s.ev.last_at != 0 { (now_ms() - s.ev.last_at) as f64 / 60000.0 } else { 0.0 };
    if live_snap(s) && q > stale_min() { format!(" [stale?: no output for {} min]", js_round(q)) } else { String::new() }
}

pub fn status_text(s: &Snapshot) -> String {
    let t = &s.t;
    let sid = t.get("sessionID").and_then(|v| v.as_str()).filter(|x| !x.is_empty()).map(|x| x.to_string()).or_else(|| s.ev.session_id.clone());
    let mut o = s.status.clone();
    if let Some(f) = t.get("failure").and_then(|v| v.as_object()) {
        if let Some(k) = f.get("kind").and_then(|v| v.as_str()) { o.push_str(&format!(" ({})", k)); }
    }
    if s.status == "retrying" {
        let ra = t.get("retryAt").and_then(|v| v.as_i64()).unwrap_or(0);
        o.push_str(&format!(" in {}s", std::cmp::max(0, js_round((ra - now_ms()) as f64 / 1000.0))));
    }
    o.push_str(&format!(" ({}s, {} chars", elapsed_of(t), chars_len(&s.text)));
    if let Some(sid) = sid { o.push_str(&format!(", session {}", sid)); }
    if t.get("attempt").and_then(|v| v.as_i64()).unwrap_or(0) > 1 {
        o.push_str(&format!(", attempt {}", t.get("attempt").and_then(|v| v.as_i64()).unwrap_or(0)));
    }
    o.push_str(&format!(") {}/{}/{}", t.get("agent").and_then(|v| v.as_str()).unwrap_or(""), t.get("tier").and_then(|v| v.as_str()).unwrap_or(""), t.get("mode").and_then(|v| v.as_str()).unwrap_or("")));
    if s.status == "done" && !s.ev.errors.is_empty() { o.push_str(&format!(" [{} error event(s) during the run]", s.ev.errors.len())); }
    o.push_str(&stale_note(s));
    if let Some(f) = t.get("fallback").and_then(|v| v.as_str()) { o.push_str(&format!(" [fallback: {}]", f)); }
    if !s.note.is_empty() { o.push_str(&format!(" [{}]", s.note)); }
    o
}

pub fn result_text(s: &Snapshot, a: &Value) -> String {
    let t = &s.t;
    let failure = t.get("failure").and_then(|v| v.as_object()).filter(|f| f.get("kind").and_then(|v| v.as_str()).is_some());
    let mut lines = vec![format!("[{}{}]", s.status, failure.map(|f| format!(": {}", f.get("kind").and_then(|v| v.as_str()).unwrap_or(""))).unwrap_or_default())];
    if let Some(f) = failure {
        lines.push(f.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string());
        if let Some(ad) = f.get("advice").and_then(|v| v.as_str()).filter(|x| !x.is_empty()) { lines.push(format!("Advice: {}", ad)); }
    }
    if s.status == "interrupted" || s.status == "lost" {
        lines.push(format!("recoverable: {}", if s.status == "lost" { "no session exists, start the task again (opencode_resume re-sends the prompt)".to_string() }
            else if is_read_only(t.get("agent").and_then(|v| v.as_str()).unwrap_or("")) { format!("yes, read-only agent: opencode_resume id={}", t.get("id").and_then(|v| v.as_str()).unwrap_or("")) }
            else { format!("partly: editing agent, check `git status` then opencode_resume id={} acknowledge_edits:true", t.get("id").and_then(|v| v.as_str()).unwrap_or("")) }));
    }
    if let Some(f) = t.get("fallback").and_then(|v| v.as_str()) {
        let mut l = format!("fallback used: {}", f);
        if let Some(fn_) = t.get("fallbackNote").and_then(|v| v.as_str()) { l.push_str(&format!(" ({})", fn_)); }
        lines.push(l);
    }
    if s.status == "retrying" {
        let ra = t.get("retryAt").and_then(|v| v.as_i64()).unwrap_or(0);
        lines.push(format!("waiting {}s before attempt {} of {}", std::cmp::max(0, js_round((ra - now_ms()) as f64 / 1000.0)), t.get("attempt").and_then(|v| v.as_i64()).unwrap_or(0) + 1, cfg().max_retries + 1));
    }
    if live_snap(s) {
        let mut l = format!("progress: {}", progress_line(s));
        if !s.note.is_empty() { l.push_str(&format!(" [{}]", s.note)); }
        l.push_str(&stale_note(s));
        lines.push(l);
    }
    if failure.is_none() && !s.ev.errors.is_empty() {
        lines.push(format!("warning: {} error event(s) during the run, first: {}", s.ev.errors.len(), clip(&s.ev.errors[0], 200)));
    }
    if s.ev.text_truncated { lines.push(format!("note: the output exceeded {} MB; only the last {} MB are kept", MAX_TEXT as f64 / 1e6, MAX_TEXT as f64 / 1e6)); }
    let mut body = if !s.text.is_empty() { s.text.clone() } else if failure.is_some() || s.status == "cancelled" { String::new() } else { "(no output yet)".into() };
    let tail_n = num(a.get("tail"), 0.0, 0.0, 5e7) as usize;
    let head_n = num(a.get("head"), 0.0, 0.0, 5e7) as usize;
    let blen = chars_len(&body);
    if tail_n > 0 && blen > tail_n { body = last_chars(&body, tail_n); }
    else if head_n > 0 && blen > head_n { body = first_chars(&body, head_n); }
    else if tail_n == 0 && head_n == 0 && blen > RESULT_CAP {
        lines.push(format!("note: {} earlier characters omitted (output is {}); pass head=N for the beginning or tail=N for a different size", blen - RESULT_CAP, blen));
        body = last_chars(&body, RESULT_CAP);
    }
    if failure.is_some() && !body.is_empty() { lines.push("--- partial output ---".into()); }
    let mut out = lines.join("\n");
    if !body.is_empty() { out.push('\n'); out.push_str(&body); }
    out
}

pub fn still_running(s: &Snapshot, secs: f64) -> String {
    let sid = s.t.get("sessionID").and_then(|v| v.as_str()).filter(|x| !x.is_empty()).map(|x| x.to_string()).or_else(|| s.ev.session_id.clone());
    format!("[still_running] task {} is {} after waiting {} s; this is normal for a long job and nothing is lost.\nprogress: {}{}{}\nNext: poll again with opencode_result id={} wait_s={} (about every {} s){}.",
        s.t.get("id").and_then(|v| v.as_str()).unwrap_or(""), s.status, secs, progress_line(s),
        if !s.note.is_empty() { format!(" [{}]", s.note) } else { String::new() }, stale_note(s),
        s.t.get("id").and_then(|v| v.as_str()).unwrap_or(""), cfg().max_wait_s, cfg().max_wait_s,
        sid.map(|id| format!(", or read the steps with opencode_session_output id={} mode=tail", id)).unwrap_or_default())
}

pub fn wait_arg(a: &Value) -> f64 { num(a.get("wait_s").or_else(|| a.get("timeout_s")), 0.0, 0.0, cfg().max_wait_s) }

/// Wait at most `secs` for a final state, calling progress after each poll. Returns the last snapshot.
pub fn wait_task(id: &str, secs: f64, aborted: &std::sync::atomic::AtomicBool, progress: &mut dyn FnMut(String)) -> Result<Snapshot, String> {
    let end = now_ms() + (secs * 1000.0) as i64;
    let mut s = snap(id)?;
    while secs > 0.0 && live_snap(&s) && now_ms() < end && !aborted.load(std::sync::atomic::Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(std::cmp::min(cfg().wait_poll_ms, std::cmp::max(1, (end - now_ms()) as u64))));
        s = snap(id)?;
        progress(format!("{}: {}", s.status, progress_line(&s)));
    }
    Ok(s)
}

pub fn cancel_task(id: &str) -> Result<String, String> {
    let s = snap(id)?;
    let t = s.t.clone();
    if !live_status(&s.status) { return Ok(format!("task already {}; nothing to cancel", s.status)); }
    if std::path::Path::new(&format!("{}/cancelled", tdir(id))).exists() { return Ok("task already cancelled; nothing to cancel".into()); }
    ensure_state();
    let _ = std::fs::write(format!("{}/cancelled", tdir(id)), format!("{}", now_ms()));
    let sid = t.get("sessionID").and_then(|v| v.as_str()).filter(|x| !x.is_empty()).map(|x| x.to_string()).or_else(|| s.ev.session_id.clone());
    let mut notes: Vec<String> = vec![];
    if let Some(ref sid) = sid { mark_cancelled_session(sid); }
    if t.get("backend").and_then(|v| v.as_str()) == Some("service") {
        if let Some(ref sid) = sid {
            if pid_alive(&t.get("child").cloned().unwrap_or(Value::Null)) {
                match crate::api::api("POST", &format!("/api/session/{}/interrupt", enc_component(sid)), &[], None) {
                    Ok(r) => {
                        if r.get("interrupted").and_then(|v| v.as_bool()).unwrap_or(false) { notes.push(format!("session {} interrupted through the service", sid)); }
                        else { notes.push(format!("the service reported no active execution for {}", sid)); }
                    }
                    Err(e) => notes.push(format!("service interrupt failed ({}); the client process was stopped instead", clip(&e, 120))),
                }
            }
        }
    }
    kill_ref(&t.get("child").cloned().unwrap_or(Value::Null), libc::SIGTERM);
    let child = t.get("child").cloned().unwrap_or(Value::Null);
    std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(cfg().kill_grace_ms)); kill_ref(&child, libc::SIGKILL); });
    match t.get("runner").and_then(|v| v.get("pid")).and_then(|v| v.as_u64()) {
        Some(pid) if pid_alive(&t.get("runner").cloned().unwrap_or(Value::Null)) => { kill_pid(pid as u32, libc::SIGTERM); }
        _ => {
            let mut cur = read_task(&Value::String(id.to_string())).unwrap_or(t);
            cur["status"] = json!("cancelled");
            cur["failure"] = Value::Null;
            cur["ended"] = json!(now_ms());
            cur["retryAt"] = Value::Null;
            write_task(&cur);
        }
    }
    let mut out = vec!["cancelled".to_string()];
    out.extend(notes);
    Ok(out.join("\n"))
}

fn cancel_session(sid: &str) -> Result<String, String> {
    let r = crate::api::api("POST", &format!("/api/session/{}/interrupt", enc_component(sid)), &[], None)?;
    if !r.get("interrupted").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok(format!("session {}: the service has no active execution to interrupt (it is idle or finished, or it is a --standalone run owned by its own client process: opencode_processes shows that pid; stop it with a pid-specific kill)", sid));
    }
    mark_cancelled_session(sid);
    let mut st = String::new();
    for _ in 0..8 {
        if !st.is_empty() { break; }
        std::thread::sleep(Duration::from_millis(250));
        if let Ok(s) = crate::api::api("GET", &format!("/api/session/{}", enc_component(sid)), &[], None) {
            let d = if s.get("data").map(|x| !x.is_null()).unwrap_or(false) { s["data"].clone() } else { s };
            if let Some(o) = d.get("outcome").and_then(|v| v.as_str()).filter(|o| !o.is_empty()) { st = o.to_string(); }
        }
    }
    Ok(format!("cancelled: session {} interrupted through the service (service outcome: {}; the bridge lists it as cancelled)", sid, if st.is_empty() { "pending" } else { &st }))
}

pub fn cancel(a: &Value) -> Result<String, String> {
    let id = arg_str(a, "id").unwrap_or_default().trim().to_string();
    if id.starts_with("ses_") && id.len() > 4 && id.chars().skip(4).all(|ch| ch.is_ascii_alphanumeric()) {
        let own = registry().into_iter().find(|t| t.get("sessionID").and_then(|v| v.as_str()) == Some(id.as_str()) && live_status(t.get("status").and_then(|v| v.as_str()).unwrap_or("")));
        return match own {
            Some(o) => cancel_task(o.get("id").and_then(|v| v.as_str()).unwrap_or("")),
            None => cancel_session(&id),
        };
    }
    cancel_task(&id)
}

pub fn resume(a: &Value) -> Result<StartOut, String> {
    let id = arg_str(a, "id").unwrap_or_default();
    let s = snap(&id)?;
    let t = s.t.clone();
    if live_snap(&s) { return Err(format!("task {} is still {}; nothing to resume (opencode_status / opencode_result show its progress)", t.get("id").and_then(|v| v.as_str()).unwrap_or(""), s.status)); }
    if s.status == "done" { return Err(format!("task {} finished successfully; read it with opencode_result (to run it again, use opencode_start)", t.get("id").and_then(|v| v.as_str()).unwrap_or(""))); }
    let editing = !is_read_only(t.get("agent").and_then(|v| v.as_str()).unwrap_or(""));
    let tree = if editing { git_status(t.get("cwd").and_then(|v| v.as_str()).unwrap_or("")) } else { String::new() };
    let ack = truthy_arg(a, "acknowledge_edits");
    if editing && !ack {
        return Err(format!("task {} used the EDITING agent \"{}\": it may have changed files before it stopped, and replaying it blindly can duplicate or clash with those changes. Working tree of {} right now (git status --short):\n{}\nInspect it (git diff), then call opencode_resume again with acknowledge_edits:true; the new run is told to inspect the tree first. Or finish the work yourself.",
            t.get("id").and_then(|v| v.as_str()).unwrap_or(""), t.get("agent").and_then(|v| v.as_str()).unwrap_or(""), t.get("cwd").and_then(|v| v.as_str()).unwrap_or(""), tree));
    }
    let original = std::fs::read_to_string(format!("{}/prompt.md", tdir(t.get("id").and_then(|v| v.as_str()).unwrap_or("")))).unwrap_or_default();
    let partial = if s.text.is_empty() { String::new() } else { last_chars(&s.text, std::cmp::min(6000, chars_len(&s.text))) };
    let tools = s.ev.tools.iter().map(|x| format!("{}({}) [{}]", x.name, x.input, x.status)).collect::<Vec<_>>().join("\n  ");
    let sid = t.get("sessionID").and_then(|v| v.as_str()).filter(|x| !x.is_empty()).map(|x| x.to_string()).or_else(|| s.ev.session_id.clone());
    let failure_msg = t.get("failure").and_then(|v| v.get("message")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut parts = vec![format!("RESUME: an earlier run of this task (id {}{}) ended as \"{}\"{}. Continue from where it stopped; do not redo finished work.",
        t.get("id").and_then(|v| v.as_str()).unwrap_or(""), sid.as_ref().map(|s| format!(", session {}", s)).unwrap_or_default(), s.status, if failure_msg.is_empty() { String::new() } else { format!(": {}", failure_msg) })];
    parts.push(if partial.is_empty() { "The earlier run produced no output.".into() } else { format!("Output of the earlier run (last part):\n{}", partial) });
    if !tools.is_empty() { parts.push(format!("Its last steps:\n  {}", tools)); }
    if editing { parts.push("The working tree may contain PARTIAL EDITS of the earlier run. Run `git status` and `git diff` first, keep what is correct, finish the rest.".into()); }
    if let Some(n) = arg_str(a, "note").filter(|x| !x.is_empty()) { parts.push(format!("Extra instruction: {}", first_chars(&n, 2000))); }
    let ctx = parts.join("\n\n");
    let same_session = truthy_arg(a, "same_session");
    let mut title = t.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    while title.ends_with(" (resume)") { title.truncate(title.len() - " (resume)".len()); }
    title.push_str(" (resume)");
    let mut args = json!({"prompt": if same_session { format!("{}\n\nContinue and finish the task.", ctx) } else { format!("{}\n\n---\n{}", original, ctx) },
        "tier": t.get("tier").cloned().unwrap_or(Value::Null), "agent": t.get("agent").cloned().unwrap_or(Value::Null),
        "mechanical": t.get("mechanical").cloned().unwrap_or(Value::Bool(false)),
        "cwd": t.get("cwd").cloned().unwrap_or(Value::Null),
        "model": t.get("model").cloned().unwrap_or(Value::Null),
        "lane": t.get("lane").cloned().unwrap_or(Value::Null), "title": title,
        "mode": t.get("mode").cloned().unwrap_or(Value::Null),
        "timeout_minutes": a.get("timeout_minutes").cloned().unwrap_or_else(|| t.get("timeoutMin").cloned().unwrap_or(Value::Null))});
    if same_session {
        if let Some(sid) = sid { args["session"] = json!(sid); }
    }
    let r = start(&args, Some((t.get("id").and_then(|v| v.as_str()).unwrap_or(""), &original)))?;
    Ok(StartOut { id: r.id.clone(), text: format!("{}\nResumed task {} ({}) as {} {}.{}",
        r.text, t.get("id").and_then(|v| v.as_str()).unwrap_or(""), s.status, r.id,
        if same_session { "in the same session" } else { "in a new session with the original prompt plus the progress so far" },
        if editing { format!("\nWorking tree at the time of the resume (git status --short):\n{}", tree) } else { String::new() }) })
}

pub fn list_text(a: &Value) -> String {
    let want = arg_str(a, "state").filter(|s| !s.is_empty()).unwrap_or_default().to_lowercase();
    let limit = num(a.get("limit"), 50.0, 1.0, 500.0) as usize;
    let me = std::process::id();
    let mut rows: Vec<Value> = registry().into_iter().filter(|t| {
        if !inside_root(t.get("cwd").and_then(|v| v.as_str()).unwrap_or("")) { return false; }
        if !want.is_empty() && t.get("status").and_then(|v| v.as_str()).unwrap_or("") != want { return false; }
        true
    }).collect();
    rows.sort_by_key(|t| t.get("started").and_then(|v| v.as_i64()).unwrap_or(0));
    let rows = &rows[rows.len().saturating_sub(limit)..];
    if rows.is_empty() { return "none".into(); }
    rows.iter().map(|t| {
        let mut r = format!("{} {}{} {}s", t.get("id").and_then(|v| v.as_str()).unwrap_or(""), t.get("status").and_then(|v| v.as_str()).unwrap_or(""),
            t.get("failure").and_then(|v| v.get("kind")).and_then(|v| v.as_str()).map(|k| format!(":{}", k)).unwrap_or_default(), elapsed_of(t));
        if let Some(sid) = t.get("sessionID").and_then(|v| v.as_str()) { r.push_str(&format!(" {}", sid)); }
        r.push_str(&format!(" {}/{}/{} {}", t.get("agent").and_then(|v| v.as_str()).unwrap_or(""), t.get("tier").and_then(|v| v.as_str()).unwrap_or(""), t.get("mode").and_then(|v| v.as_str()).unwrap_or(""), clip(t.get("title").and_then(|v| v.as_str()).unwrap_or(""), 60)));
        let bridge_pid = t.get("bridge").and_then(|v| v.get("pid")).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        if bridge_pid != me { r.push_str(" [earlier bridge instance]"); }
        r
    }).collect::<Vec<_>>().join("\n")
}

/// Housekeeping at start-up: drop old finished task directories (and their attachments).
pub fn prune_state() {
    let now = now_ms();
    let mut fin: Vec<Value> = registry().into_iter().filter(|t| is_final_status(t.get("status").and_then(|v| v.as_str()).unwrap_or(""))).collect();
    fin.sort_by_key(|t| t.get("ended").and_then(|v| v.as_i64()).or_else(|| t.get("started").and_then(|v| v.as_i64())).unwrap_or(0));
    let mut drop: Vec<String> = fin.iter().filter(|t| now - t.get("ended").and_then(|v| v.as_i64()).or_else(|| t.get("started").and_then(|v| v.as_i64())).unwrap_or(0) > cfg().keep_days_ms)
        .filter_map(|t| t.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())).collect();
    for t in fin.iter().take(fin.len().saturating_sub(KEEP_FINISHED)) {
        if let Some(id) = t.get("id").and_then(|v| v.as_str()) {
            if !drop.contains(&id.to_string()) { drop.push(id.to_string()); }
        }
    }
    for id in drop {
        if let Some(t) = read_task(&Value::String(id.clone())) {
            if let Some(a) = t.get("attachDir").and_then(|v| v.as_str()) { let _ = std::fs::remove_dir_all(a); }
        }
        let _ = std::fs::remove_dir_all(tdir(&id));
    }
    if let Ok(rd) = std::fs::read_dir(cancel_dir()) {
        for e in rd.flatten() {
            let p = e.path().to_string_lossy().to_string();
            if let Ok(content) = std::fs::read_to_string(&p) {
                if let Ok(ts) = content.trim().parse::<i64>() {
                    if now - ts > cfg().keep_days_ms { let _ = std::fs::remove_file(&p); }
                }
            }
        }
    }
}

/// Safety net of the bridge: reconcile tasks whose supervisor (runner) is gone.
pub fn supervise() {
    for t in registry() {
        if is_final_status(t.get("status").and_then(|v| v.as_str()).unwrap_or("")) { continue; }
        if pid_alive(&t.get("runner").cloned().unwrap_or(Value::Null)) { continue; }
        if let Some(id) = t.get("id").and_then(|v| v.as_str()) { let _ = snap(id); }
    }
}

/// Client gone / SIGTERM: tasks are DETACHED and keep running. Only with
/// OPENCODE_BRIDGE_KILL_ON_EXIT=1 cancel this instance's tasks (legacy behaviour).
pub fn shutdown_all() {
    if cfg().kill_on_exit {
        for t in registry() {
            if is_final_status(t.get("status").and_then(|v| v.as_str()).unwrap_or("")) { continue; }
            let bridge_pid = t.get("bridge").and_then(|v| v.get("pid")).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            if bridge_pid != std::process::id() { continue; }
            let id = match t.get("id").and_then(|v| v.as_str()) { Some(s) => s.to_string(), None => continue };
            let _ = std::fs::write(format!("{}/cancelled", tdir(&id)), format!("{}", now_ms()));
            if pid_alive(&t.get("runner").cloned().unwrap_or(Value::Null)) {
                if let Some(pid) = t.get("runner").and_then(|v| v.get("pid")).and_then(|v| v.as_u64()) {
                    kill_pid(pid as u32, libc::SIGTERM);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(400));
    } else {
        std::thread::sleep(Duration::from_millis(50));
    }
}
