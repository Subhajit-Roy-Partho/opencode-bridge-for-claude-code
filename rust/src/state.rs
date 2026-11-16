// Persistent task state (docs/STATE.md): STATE_DIR/tasks/<id>/ with task.json, runner.json,
// prompt.md, out.<attempt>.jsonl, err.<attempt>.log, cancelled, result.txt, runner.log;
// cancelled/<session id> sessions. Process references {pid, start} (field 22 of /proc/<pid>/stat).
use crate::config::*;
use crate::util::*;
use serde_json::Value;

pub fn tasks_dir() -> String { format!("{}/tasks", state_dir()) }
pub fn cancel_dir() -> String { format!("{}/cancelled", state_dir()) }
pub fn tdir(id: &str) -> String { format!("{}/{}", tasks_dir(), id) }

pub fn ensure_state() {
    for d in [tasks_dir(), cancel_dir()] {
        let _ = std::fs::create_dir_all(&d);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700));
        }
    }
}

/// Atomic write (tmp file + rename), file mode 0600.
pub fn atomic_write(file: &str, data: &str) {
    use std::io::Write;
    static CTR: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = CTR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmpf = format!("{}.{}.{}.tmp", file, std::process::id(), n);
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(&tmpf).expect("atomic write");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmpf, std::fs::Permissions::from_mode(0o600));
    }
    f.write_all(data.as_bytes()).expect("atomic write");
    let _ = f.sync_all();
    std::fs::rename(&tmpf, file).expect("atomic write rename");
}

pub fn write_file_600(file: &str, data: &[u8]) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(file).expect("write");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600));
    }
    f.write_all(data).expect("write");
    let _ = f.sync_all();
}

pub fn read_json(file: &str) -> Option<Value> {
    std::fs::read_to_string(file).ok().and_then(|s| serde_json::from_str(&s).ok())
}

pub fn write_task(t: &Value) {
    let id = t["id"].as_str().unwrap_or("");
    atomic_write(&format!("{}/task.json", tdir(id)), &serde_json::to_string(t).unwrap());
}

/// Read a task record; merges runner.json as `runner` like server.mjs readTask.
pub fn read_task(id: &Value) -> Option<Value> {
    let sid = match id { Value::String(s) => s.clone(), _ => return None };
    if sid.len() != 8 || !sid.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
    let mut t = read_json(&format!("{}/task.json", tdir(&sid)))?;
    if t.get("runner").is_none() {
        if let Some(r) = read_json(&format!("{}/runner.json", tdir(&sid))) {
            t["runner"] = r;
        }
    }
    Some(t)
}

pub fn registry() -> Vec<Value> {
    let mut ids: Vec<String> = vec![];
    if let Ok(rd) = std::fs::read_dir(tasks_dir()) {
        for e in rd.flatten() {
            if let Some(n) = e.file_name().to_str() { ids.push(n.to_string()); }
        }
    }
    ids.iter().filter_map(|id| read_task(&Value::String(id.clone()))).collect()
}

pub fn is_final_status(s: &str) -> bool {
    matches!(s, "done" | "failed" | "timeout" | "cancelled" | "interrupted" | "lost")
}

fn clean_sid(s: &str) -> String { s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect() }

pub fn mark_cancelled_session(sid: &str) {
    ensure_state();
    let _ = std::fs::write(format!("{}/{}", cancel_dir(), clean_sid(sid)), format!("{}", now_ms()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(format!("{}/{}", cancel_dir(), clean_sid(sid)), std::fs::Permissions::from_mode(0o600));
    }
}

pub fn is_cancelled_session(sid: &str) -> bool {
    std::path::Path::new(&format!("{}/{}", cancel_dir(), clean_sid(sid))).exists()
}

// process references {pid, start}: start = field 22 of /proc/<pid>/stat; a zombie counts as dead.
pub fn proc_info(pid: u32) -> Option<(String, String)> {
    if !cfg().procfs { return None; }
    let s = std::fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
    let r = s.rfind(')')?;
    let rest: Vec<&str> = s[r + 2..].split(' ').collect();
    if rest.len() < 20 { return None; }
    Some((rest[0].to_string(), rest[19].to_string()))
}

pub fn pid_ref(pid: u32) -> Value {
    match proc_info(pid).map(|x| x.1) {
        Some(s) => serde_json::json!({"pid": pid, "start": s}),
        None => serde_json::json!({"pid": pid, "start": Value::Null}),
    }
}

/// True while the referenced process is alive (zombies dead; recycled pids rejected via start).
pub fn pid_alive(p: &Value) -> bool {
    let pid = match p.get("pid").and_then(|v| v.as_u64()) { Some(n) => n as u32, None => return false };
    if pid == 0 { return false; }
    unsafe {
        if libc::kill(pid as i32, 0) != 0 {
            if *libc::__errno_location() != libc::EPERM { return false; }
        }
    }
    if let Some((state, start)) = proc_info(pid) {
        if state == "Z" { return false; }
        if let Some(s) = p.get("start").and_then(|v| v.as_str()) {
            if start != s { return false; }
        }
    }
    true
}

/// SIGTERM/SIGKILL to the process group (the child leads its own group); falls back to the bare pid.
pub fn kill_ref(p: &Value, sig: i32) -> bool {
    if !pid_alive(p) { return false; }
    let pid = p.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as i32;
    unsafe {
        if libc::kill(-pid, sig) == 0 { return true; }
        libc::kill(pid, sig) == 0
    }
}

pub fn kill_pid(pid: u32, sig: i32) -> bool {
    if pid == 0 { return false; }
    unsafe { libc::kill(pid as i32, sig) == 0 }
}

pub fn spawn_failure(code: Option<&str>, msg: &str) -> Value {
    if code == Some("ENOENT") || msg.contains("No such file") || msg.contains("not found") {
        serde_json::json!({"kind": "spawn", "message": "the opencode binary was not found on PATH", "advice": "Install opencode (>= 2) and make sure the process that runs the bridge has it on PATH.", "transient": false})
    } else {
        serde_json::json!({"kind": "spawn", "message": clip(msg, 300), "advice": "", "transient": false})
    }
}

// ---------- event stream of one attempt (`opencode run --format json`, one JSON object per line) ----------
pub struct Ev {
    pub session_id: Option<String>,
    pub text: String,
    pub text_truncated: bool,
    pub errors: Vec<String>,
    pub steps: u64,
    pub tools: Vec<ToolUse>,
    pub tokens_in: f64,
    pub tokens_out: f64,
    pub last_at: i64,
}

pub struct ToolUse { pub name: String, pub input: String, pub status: String }

fn new_ev() -> Ev {
    Ev { session_id: None, text: String::new(), text_truncated: false, errors: vec![], steps: 0, tools: vec![], tokens_in: 0.0, tokens_out: 0.0, last_at: 0 }
}

pub fn read_events(id: &str, attempt: i64) -> Ev {
    let mut e = new_ev();
    let file = format!("{}/out.{}.jsonl", tdir(id), attempt);
    let meta = match std::fs::metadata(&file) { Ok(m) => m, Err(_) => return e };
    e.last_at = meta.modified().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "x"))).map(|d| d.as_millis() as i64).unwrap_or(0);
    let data = match std::fs::read(&file) { Ok(d) => d, Err(_) => return e };
    let s = String::from_utf8_lossy(&data).to_string();
    for line in s.split('\n') {
        ingest(&mut e, line);
    }
    e
}

fn ingest(e: &mut Ev, l: &str) {
    let j: Value = match serde_json::from_str(l) { Ok(v) => v, Err(_) => return };
    if !j.is_object() { return; }
    if e.session_id.is_none() {
        if let Some(s) = j.get("sessionID").and_then(|v| v.as_str()).filter(|x| !x.is_empty()) {
            e.session_id = Some(s.to_string());
        }
    }
    match j.get("type").and_then(|v| v.as_str()) {
        Some("text") => {
            if let Some(p) = j.get("part").and_then(|v| v.get("text")).and_then(|v| v.as_str()) {
                e.text.push_str(p);
            }
            if chars_len(&e.text) > MAX_TEXT { keep_last_chars(&mut e.text, MAX_TEXT); e.text_truncated = true; }
        }
        Some("error") if e.errors.len() < 20 => {
            let src = if !j.get("error").map(|v| v.is_null()).unwrap_or(true) { &j["error"] } else if !j.get("message").map(|v| v.is_null()).unwrap_or(true) { &j["message"] } else { &j };
            e.errors.push(err_text(src));
        }
        Some("step_start") => { e.steps += 1; }
        Some("step_finish") => {
            e.tokens_in += j.get("part").and_then(|v| v.get("tokens")).and_then(|v| v.get("input")).and_then(|v| v.as_f64()).unwrap_or(0.0);
            e.tokens_out += j.get("part").and_then(|v| v.get("tokens")).and_then(|v| v.get("output")).and_then(|v| v.as_f64()).unwrap_or(0.0);
        }
        Some("tool_use") => {
            let p = j.get("part").cloned().unwrap_or(Value::Null);
            let inp = p.get("state").and_then(|v| v.get("input"));
            let inp_s = match inp { Some(Value::String(s)) => s.clone(), Some(v) => serde_json::to_string(v).unwrap_or_default(), None => "{}".to_string() };
            e.tools.push(ToolUse {
                name: p.get("tool").and_then(|v| v.as_str()).unwrap_or("?").to_string(),
                input: clip(&inp_s, 90),
                status: p.get("state").and_then(|v| v.get("status")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            });
            if e.tools.len() > 6 { e.tools.remove(0); }
        }
        _ => {}
    }
}

pub fn read_tail_file(file: &str, n: u64) -> String {
    let data = match std::fs::read(file) { Ok(d) => d, Err(_) => return String::new() };
    let len = std::cmp::min(n as usize, data.len());
    String::from_utf8_lossy(&data[data.len() - len..]).to_string()
}
