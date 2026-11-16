// The runner: one detached process per task (`opencode-bridge --runner <dir>`).
// Owns the task while it lives: starts `opencode run` (detached, own process group,
// stdout/stderr appended to the attempt files), tails out.N.jsonl every 250 ms for the
// session id, enforces the deadline and the cancel marker, classifies the outcome,
// retries (read-only agents, transient errors, no output) and falls back (step limit),
// and writes the final state BEFORE it exits. A cancel marker always wins.
use crate::config::*;
use crate::state::*;
use crate::svc::*;
use crate::util::*;
use serde_json::{json, Value};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn on_term(_: libc::c_int) { STOP.store(true, Ordering::SeqCst); }

fn rd(dir: &str, f: &str) -> String { format!("{}/{}", dir, f) }

struct Runner {
    dir: String,
    t: Value,
    child: Option<Value>,
    killed_at: i64,
}

impl Runner {
    fn save(&mut self, patch: Value) {
        let mut cur = read_json(&rd(&self.dir, "task.json")).unwrap_or_else(|| self.t.clone());
        if let Value::Object(map) = patch {
            if let Value::Object(curmap) = &mut cur {
                for (k, v) in map { curmap.insert(k, v); }
            }
        }
        self.t = cur.clone();
        write_task(&cur);
    }

    fn cancelled(&self) -> bool {
        STOP.load(Ordering::SeqCst) || std::path::Path::new(&rd(&self.dir, "cancelled")).exists()
    }

    fn mark_cancelled(&self) {
        let _ = std::fs::OpenOptions::new().create(true).append(true).open(rd(&self.dir, "cancelled"))
            .and_then(|mut f| { use std::io::Write; f.write_all(format!("{}", now_ms()).as_bytes()).map(|_| f).and_then(|f| f.sync_all().map(|_| ())) });
    }

    fn stop_child(&mut self) {
        if self.killed_at != 0 { return; }
        self.killed_at = now_ms();
        if let Some(c) = self.child.clone() { kill_ref(&c, libc::SIGTERM); }
    }

    fn poll_kill(&self) {
        if self.killed_at != 0 && now_ms() - self.killed_at > cfg().kill_grace_ms as i64 {
            if let Some(c) = self.child.clone() { kill_ref(&c, libc::SIGKILL); }
        }
    }

    fn cleanup(&self) {
        if let Some(d) = self.t.get("attachDir").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    fn end(&mut self, status: &str, failure: Option<Value>, extra: Value) -> ! {
        self.cleanup();
        let mut status = status.to_string();
        let mut failure = failure;
        if self.cancelled() && status != "done" { status = "cancelled".into(); failure = None; }
        let mut patch = json!({"status": status, "failure": failure, "ended": now_ms(), "retryAt": Value::Null});
        if let Value::Object(m) = extra {
            if let Value::Object(p) = &mut patch {
                for (k, v) in m { p.insert(k, v); }
            }
        }
        self.save(patch);
        std::process::exit(0);
    }

    fn wait_ms(&mut self, ms: u64) {
        let until = now_ms() + ms as i64;
        while now_ms() < until && !self.cancelled() {
            std::thread::sleep(Duration::from_millis(std::cmp::min(200, (until - now_ms()).max(1) as u64)));
        }
    }

    fn attempt_ev(&self, attempt: i64) -> crate::state::Ev {
        read_events(self.t.get("id").and_then(|v| v.as_str()).unwrap_or(""), attempt)
    }
}

pub fn run(dir: &str) -> ! {
    unsafe {
        libc::signal(libc::SIGTERM, on_term as *const () as usize);
        libc::signal(libc::SIGINT, on_term as *const () as usize);
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
    }
    let t = match read_json(&rd(dir, "task.json")) {
        Some(v) => v,
        None => std::process::exit(2),
    };
    let mut r = Runner { dir: dir.to_string(), t, child: None, killed_at: 0 };
    let finalize_prompt = "The step limit of this agent was reached (the provider rejects the forced final step). Do NOT call any more tools. Write your final report NOW from what you have already gathered: findings with file paths and line numbers, what is verified and what is not, open questions. If something is missing, say so instead of searching.";
    let mut attempt = r.t.get("attempt").and_then(|v| v.as_i64()).unwrap_or(0);
    let mut session_id: Option<String> = r.t.get("resumeSession").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let mut finalize_msg: Option<String> = None;
    loop {
        // A signal (or the bridge going away with KILL_ON_EXIT) means: cancel and stop the child, like Node's SIGTERM handler.
        if STOP.load(Ordering::SeqCst) { r.mark_cancelled(); r.stop_child(); }
        if r.cancelled() { r.end("cancelled", None, json!({})); }
        let deadline = r.t.get("deadline").and_then(|v| v.as_i64()).unwrap_or(i64::MAX);
        let timeout_ms = r.t.get("timeoutMs").and_then(|v| v.as_u64()).unwrap_or(0);
        if now_ms() > deadline {
            r.end("timeout", Some(json!({"kind": "timeout", "message": format!("no result after {} s", js_round(timeout_ms as f64 / 1000.0)), "advice": "Split the task into smaller pieces or raise timeout_minutes / OPENCODE_BRIDGE_TIMEOUT_MIN. Any partial output is in opencode_result.", "transient": false})), json!({}));
        }
        attempt += 1;
        let agent = r.t.get("agent").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let backend = r.t.get("backend").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let argv = build_args(&r.t, session_id.as_deref(), finalize_msg.as_deref());
        let out_f = std::fs::OpenOptions::new().create(true).append(true).open(rd(dir, &format!("out.{}.jsonl", attempt)));
        let err_f = std::fs::OpenOptions::new().create(true).append(true).open(rd(dir, &format!("err.{}.log", attempt)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(rd(dir, &format!("out.{}.jsonl", attempt)), std::fs::Permissions::from_mode(0o600));
            let _ = std::fs::set_permissions(rd(dir, &format!("err.{}.log", attempt)), std::fs::Permissions::from_mode(0o600));
        }
        let (out_f, err_f) = match (out_f, err_f) { (Ok(o), Ok(e)) => (o, e), _ => {
            r.end("failed", Some(spawn_failure(Some("EACCES"), "cannot open the attempt output files")), json!({}));
        }};
        let cwd = r.t.get("cwd").and_then(|v| v.as_str()).unwrap_or("/").to_string();
        r.killed_at = 0;
        r.child = None;
        let mut spawn_err: Option<(Option<String>, String)> = None;
        let mut child_opt = None;
        {
            let mut cmd = Command::new("opencode");
            cmd.args(&argv).current_dir(&cwd).env("PWD", &cwd)
                .stdin(Stdio::null()).stdout(Stdio::from(out_f)).stderr(Stdio::from(err_f))
                .process_group(0);
            if backend == "standalone" { cmd.env("OPENCODE_CONFIG_CONTENT", WORKER_CONFIG); }
            match cmd.spawn() {
                Ok(c) => { child_opt = Some(c); }
                Err(e) => {
                    let code = e.raw_os_error().map(|n| if n == libc::ENOENT { "ENOENT" } else if n == libc::E2BIG { "E2BIG" } else { "" });
                    spawn_err = Some((code.map(|s| s.to_string()), e.to_string()));
                }
            }
        }
        if let Some(c) = child_opt.as_ref() {
            r.child = Some(pid_ref(c.id()));
        }
        let mut patch = json!({"attempt": attempt, "child": r.child.clone(), "status": "running", "retryAt": Value::Null});
        if let Some(s) = &session_id { patch["sessionID"] = json!(s); }
        if finalize_msg.is_some() { patch["fallback"] = json!("finalize-in-session"); }
        r.save(patch);
        // wait for the exit, polling every 250 ms (session id, deadline, cancel)
        let mut timed_out = false;
        let (mut code, mut signame): (Option<i32>, Option<String>) = (None, None);
        if let Some(mut child) = child_opt {
            loop {
                if STOP.load(Ordering::SeqCst) { r.mark_cancelled(); }
                let ev = r.attempt_ev(attempt);
                if let Some(sid) = ev.session_id {
                    let cur = r.t.get("sessionID").and_then(|v| v.as_str()).unwrap_or("");
                    if sid != cur { r.save(json!({"sessionID": sid})); session_id = Some(sid); }
                    else if session_id.is_none() { session_id = Some(sid); }
                }
                if !timed_out && now_ms() > deadline { timed_out = true; r.stop_child(); }
                if r.cancelled() { r.stop_child(); }
                r.poll_kill();
                match child.try_wait() {
                    Ok(Some(st)) => {
                        code = st.code();
                        #[cfg(unix)]
                        {
                            use std::os::unix::process::ExitStatusExt;
                            if let Some(s) = st.signal() { signame = Some(sig_name(s)); }
                        }
                        let _ = child.wait();
                        break;
                    }
                    Ok(None) => {
                        // the heavier checks above run every 250 ms; the child's exit and a cancel are noticed within ~10 ms
                        let until = std::time::Instant::now() + Duration::from_millis(250);
                        while std::time::Instant::now() < until {
                            std::thread::sleep(Duration::from_millis(10));
                            if STOP.load(Ordering::SeqCst) || r.cancelled() { break; }
                            if !matches!(child.try_wait(), Ok(None)) { break; }
                        }
                    }
                    Err(_) => break,
                }
            }
        }
        r.child = None;
        let ev = r.attempt_ev(attempt);
        if ev.session_id.is_some() { session_id = ev.session_id.clone(); }
        else if session_id.is_none() { session_id = r.t.get("sessionID").and_then(|v| v.as_str()).map(|s| s.to_string()); }
        let err_tail = read_tail_file(&rd(dir, &format!("err.{}.log", attempt)), 4000);
        let mut base = json!({"exitCode": code, "signal": signame.clone().map(Value::String).unwrap_or(Value::Null)});
        if let Some(s) = &session_id { base["sessionID"] = json!(s); }
        if r.cancelled() { r.end("cancelled", None, base); }
        if let Some((ecode, emsg)) = spawn_err {
            r.end("failed", Some(spawn_failure(ecode.as_deref(), &emsg)), base);
        }
        if timed_out {
            let m = if timeout_ms >= 60000 { format!("{} min", js_round(timeout_ms as f64 / 60000.0)) } else { format!("{} ms", timeout_ms) };
            r.end("timeout", Some(json!({"kind": "timeout", "message": format!("no result after {}; the process group was killed", m), "advice": "Split the task into smaller pieces or raise timeout_minutes / OPENCODE_BRIDGE_TIMEOUT_MIN. Any partial output is in opencode_result.", "transient": false})), base);
        }
        // The client died (signal / crash) but the service may still be running the session.
        let mut svc: Option<crate::svc::Reattached> = None;
        if backend == "service" && session_id.is_some() && (signame.is_some() || (code != Some(0) && ev.errors.is_empty())) {
            let sid = session_id.clone().unwrap();
            svc = reattach(&sid, deadline, || {
                std::path::Path::new(&rd(dir, "cancelled")).exists()
            });
        }
        if let Some(s) = &svc {
            if s.outcome == "succeeded" {
                if !s.text.is_empty() { write_file_600(&rd(dir, "result.txt"), s.text.as_bytes()); }
                let mut b = base.clone(); b["reattached"] = json!(true);
                r.end("done", None, b);
            }
            if s.outcome == "interrupted" {
                let sigbit = signame.clone().map(|s| format!(" (client killed by {})", s)).unwrap_or_default();
                let mut b = base.clone(); b["reattached"] = json!(true);
                r.end("interrupted", Some(json!({"kind": "interrupted", "message": format!("the session was interrupted in the service{}", sigbit), "advice": INTERRUPTED_ADVICE, "transient": false})), b);
            }
        }
        let mut failure: Option<Value> = None;
        if let Some(s) = &svc {
            if s.outcome == "failed" {
                let c = classify(&s.error);
                failure = Some(json!({"kind": if c.kind == "other" { "exit".to_string() } else { c.kind }, "message": clip(&s.error, 400), "advice": c.advice, "transient": c.transient}));
            }
        } else if code != Some(0) || (!ev.errors.is_empty() && ev.text.is_empty()) {
            let errs = ev.errors.join(" ");
            if ev.errors.is_empty() && signame.is_some() {
                r.end("interrupted", Some(json!({"kind": "interrupted", "message": format!("the opencode client was killed by {} before it reported an outcome", signame.clone().unwrap()), "advice": INTERRUPTED_ADVICE, "transient": false})), base);
            }
            if !ev.errors.is_empty() && ev.errors.iter().all(|x| auto_abort(x)) {
                r.end("interrupted", Some(json!({"kind": "interrupted", "message": clip(&ev.errors[0], 300), "advice": INTERRUPTED_ADVICE, "transient": false})), base);
            }
            let msg = if !ev.errors.is_empty() { ev.errors[0].clone() }
                else if let Some(l) = err_tail.trim().lines().filter(|l| !l.is_empty()).last() { l.to_string() }
                else if let Some(s) = &signame { format!("killed by signal {}", s) }
                else { format!("exit code {}", code.map(|c| c.to_string()).unwrap_or("null".into())) };
            let c = classify(&format!("{} {}", errs, err_tail));
            failure = Some(json!({"kind": if c.kind == "other" { if signame.is_some() { "signal".to_string() } else { "exit".to_string() } } else { c.kind }, "message": clip(&msg, 400), "advice": c.advice, "transient": c.transient}));
        }
        if failure.is_none() { r.end("done", None, base); }
        let f = failure.clone().unwrap();
        let kind = f.get("kind").and_then(|v| v.as_str()).unwrap_or("").to_string();
        // step limit: let a read-only agent finish its report in the same session, once
        if kind == "step_limit" && is_read_only(&agent) && session_id.is_some() && finalize_msg.is_none() {
            finalize_msg = Some(format!("{}\n{}\n\n{}", guard_for(&agent), agent_rule(&agent), finalize_prompt));
            let fmsg = f.get("message").and_then(|v| v.as_str()).unwrap_or("");
            let mut p = base.clone();
            p["fallbackNote"] = json!(format!("attempt {} hit the step limit ({}); the report was requested in the same session", attempt, first_chars(fmsg, 80)));
            r.save(p);
            continue;
        }
        // retry only what is safe to replay: transient errors of READ-ONLY agents with no output yet
        let max_retries = r.t.get("maxRetries").and_then(|v| v.as_u64()).unwrap_or(0) as i64;
        let retry_delay = r.t.get("retryDelayMs").and_then(|v| v.as_u64()).unwrap_or(0);
        if f.get("transient").and_then(|v| v.as_bool()).unwrap_or(false) && is_read_only(&agent) && ev.text.is_empty() && (attempt as i64) <= max_retries {
            let delay = retry_delay.saturating_mul(3u64.pow((attempt - 1).max(0) as u32));
            let mut p = base.clone();
            p["status"] = json!("retrying");
            p["failure"] = f;
            p["retryAt"] = json!(now_ms() + delay as i64);
            p["attempt"] = json!(attempt);
            r.save(p);
            r.wait_ms(delay);
            continue;
        }
        r.end("failed", Some(f), base);
    }
}

fn guard_for(agent: &str) -> &'static str {
    if agent == "general" || agent == "deep-research" { txt("guardLanes") } else { txt("guard") }
}
fn agent_rule(agent: &str) -> &'static str {
    if is_read_only(agent) { txt("agentRuleReadOnly") } else { txt("agentRuleEdit") }
}
