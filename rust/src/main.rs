// opencode-bridge (Rust port of server.mjs): stdio MCP server between Claude Code and opencode.
// Same tools, same texts (embedded from data/texts.json, exported from the Node original), same behaviour.
mod api;
mod config;
mod policy;
mod procs;
mod runner;
mod sessions;
mod state;
mod svc;
mod tasks;
mod util;

use config::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use util::*;

static STOP: AtomicBool = AtomicBool::new(false);
static CLOSING: AtomicBool = AtomicBool::new(false);
static OUT: Mutex<()> = Mutex::new(());

struct Inflight {
    aborted: AtomicBool,
    message: Mutex<String>,
    done: AtomicBool,
}

fn inflight_map() -> &'static Mutex<HashMap<String, Arc<Inflight>>> {
    static M: std::sync::OnceLock<Mutex<HashMap<String, Arc<Inflight>>>> = std::sync::OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn send(v: Value) {
    let _g = OUT.lock().unwrap_or_else(|e| e.into_inner());
    let mut o = std::io::stdout().lock();
    if writeln!(o, "{}", v).is_err() || o.flush().is_err() { do_shutdown(0); }
}

fn notify_progress(tok: &Value, n: i64, message: String) {
    send(json!({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progressToken": tok, "progress": n, "message": first_chars(&message, 300)}}));
}

fn do_shutdown(code: i32) -> ! {
    if CLOSING.swap(true, Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(500));
        std::process::exit(code);
    }
    tasks::shutdown_all();
    std::process::exit(code);
}

fn cap_response(t: String) -> String {
    let n = chars_len(&t);
    if n <= RESPONSE_CAP { return t; }
    format!("{}\n…[{} characters omitted to stay within the tool-output limit; narrow the request]…\n{}", first_chars(&t, RESPONSE_CAP * 6 / 10), n - RESPONSE_CAP, last_chars(&t, RESPONSE_CAP * 4 / 10))
}

fn call_tool(name: &str, a: &Value, aborted: &AtomicBool, progress: &mut dyn FnMut(String)) -> Result<String, String> {
    match name {
        "opencode_start" => {
            let r = tasks::start(a, None)?;
            let w = tasks::wait_arg(a);
            if w == 0.0 { return Ok(r.text); }
            let s = tasks::wait_task(&r.id, w, aborted, progress)?;
            if !is_final(&s.status) { Ok(format!("{}\n{}", r.text, tasks::still_running(&s, w))) }
            else { Ok(format!("{}\n{}\n{}", r.text, tasks::status_text(&s), tasks::result_text(&s, &json!({})))) }
        }
        "opencode_policy" => policy::policy_text(a),
        "opencode_status" => {
            let w = tasks::wait_arg(a);
            let s = tasks::wait_task(&arg_str(a, "id").unwrap_or_default(), w, aborted, progress)?;
            Ok(tasks::status_text(&s))
        }
        "opencode_result" => {
            let w = tasks::wait_arg(a);
            let s = tasks::wait_task(&arg_str(a, "id").unwrap_or_default(), w, aborted, progress)?;
            if w != 0.0 && !is_final(&s.status) { Ok(tasks::still_running(&s, w)) } else { Ok(tasks::result_text(&s, a)) }
        }
        "opencode_cancel" => tasks::cancel(a),
        "opencode_resume" => tasks::resume(a).map(|r| r.text),
        "opencode_list" => Ok(tasks::list_text(a)),
        "opencode_sessions" => sessions::sessions(a),
        "opencode_session_output" => sessions::session_output(a),
        "opencode_session_rename" => sessions::rename(a),
        "opencode_processes" => procs::processes(),
        _ => Err("unknown tool".into()),
    }
}

fn is_final(s: &str) -> bool { crate::state::is_final_status(s) }

fn budget_err(name: &str) -> String {
    let ms = cfg().call_budget_ms as f64;
    let secs = js_round(ms / 100.0) as f64 / 10.0;
    format!("{} did not finish within the bridge's {} s budget (the opencode service or a lookup is slow). Nothing is lost: running tasks continue in the background; retry in a few seconds{}.",
        name, secs, if name.contains("start") || name.contains("cancel") || name.contains("resume") { " (check opencode_list first: the action may have been performed)" } else { "" })
}

fn handle_call(id: Value, m: Value) {
    let key = serde_json::to_string(&id).unwrap_or_default();
    let name = match &m["params"]["name"] { Value::String(s) => s.clone(), Value::Null => String::new(), o => o.to_string() };
    let args = match &m["params"]["arguments"] { Value::Object(_) => m["params"]["arguments"].clone(), _ => json!({}) };
    let ctx = Arc::new(Inflight { aborted: AtomicBool::new(false), message: Mutex::new("working".into()), done: AtomicBool::new(false) });
    inflight_map().lock().unwrap().insert(key.clone(), ctx.clone());
    let tok = m["params"]["_meta"]["progressToken"].clone();
    let hb = if !tok.is_null() {
        let ctx2 = ctx.clone();
        let tok2 = tok.clone();
        Some(std::thread::spawn(move || {
            let mut n = 0i64;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(cfg().progress_ms));
                if ctx2.done.load(Ordering::SeqCst) || STOP.load(Ordering::SeqCst) { break; }
                n += 1;
                let msg = ctx2.message.lock().unwrap().clone();
                notify_progress(&tok2, n, msg);
            }
        }))
    } else { None };
    // No tool call may block longer than the budget: race the work against a timer (the work continues in the background).
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let n2 = name.clone();
    let a2 = args.clone();
    let ctx2 = ctx.clone();
    std::thread::spawn(move || {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut prog = |msg: String| { *ctx2.message.lock().unwrap() = msg; };
            call_tool(&n2, &a2, &ctx2.aborted, &mut prog)
        })).unwrap_or_else(|_| Err("internal error".into()));
        let _ = tx.send(r);
    });
    let res = match rx.recv_timeout(std::time::Duration::from_millis(cfg().call_budget_ms)) {
        Ok(r) => r,
        Err(_) => Err(budget_err(&name)),
    };
    ctx.done.store(true, Ordering::SeqCst);
    if let Some(h) = hb { let _ = h.join(); }
    inflight_map().lock().unwrap().remove(&key);
    match res {
        Ok(t) => send(json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": cap_response(t)}]}})),
        Err(e) => send(json!({"jsonrpc": "2.0", "id": id, "result": {"isError": true, "content": [{"type": "text", "text": cap_response(e)}]}})),
    }
}

extern "C" fn on_signal(_: libc::c_int) { STOP.store(true, Ordering::SeqCst); }

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 2 && args[1] == "--runner" {
        runner::run(&args[2]);
    }
    let _ = texts(); // parse the embedded texts (and fail early if broken)
    state::ensure_state();
    unsafe { for s in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] { libc::signal(s, on_signal as *const () as usize); } }
    std::thread::spawn(|| loop { std::thread::sleep(std::time::Duration::from_millis(50)); if STOP.load(Ordering::SeqCst) { do_shutdown(0); } });
    // housekeeping at start-up, then the 15 s safety net
    tasks::prune_state();
    tasks::supervise();
    std::thread::spawn(|| loop { std::thread::sleep(std::time::Duration::from_millis(15000)); if !STOP.load(Ordering::SeqCst) { tasks::supervise(); } });
    let stdin = std::io::stdin();
    let mut rd = stdin.lock();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match rd.read_until(b'\n', &mut buf) { Ok(0) | Err(_) => break, Ok(_) => {} }
        let m: Value = match serde_json::from_str(String::from_utf8_lossy(&buf).trim()) { Ok(v) => v, Err(_) => continue };
        if !m.is_object() { continue; }
        if m.get("method").and_then(|v| v.as_str()) == Some("notifications/cancelled") {
            let rid = serde_json::to_string(&m["params"]["requestId"]).unwrap_or_default();
            if let Some(c) = inflight_map().lock().unwrap().get(&rid) { c.aborted.store(true, Ordering::SeqCst); }
            continue;
        }
        let id = match m.get("id") { None | Some(Value::Null) => continue, Some(i) => i.clone() }; // notification or junk
        match m["method"].as_str().unwrap_or("") {
            "initialize" => {
                let pv = m["params"]["protocolVersion"].as_str().map(|s| s.to_string()).unwrap_or_else(|| "2024-11-05".into());
                send(json!({"jsonrpc": "2.0", "id": id, "result": {"protocolVersion": pv, "capabilities": {"tools": {}}, "serverInfo": {"name": "opencode-bridge", "version": VERSION}, "instructions": txt("instructions")}}));
            }
            "tools/list" => send(json!({"jsonrpc": "2.0", "id": id, "result": {"tools": texts().tools}})),
            "tools/call" => { std::thread::spawn(move || handle_call(id, m)); }
            _ => send(json!({"jsonrpc": "2.0", "id": id, "result": {}})),
        }
    }
    do_shutdown(0);
}
