// opencode-bridge (Rust port of server.mjs): stdio MCP server between Claude Code and opencode.
// Same tools, same texts (embedded from data/texts.json, exported from the Node original), same behaviour.
mod api;
mod config;
mod policy;
mod procs;
mod sessions;
mod tasks;
mod util;

use config::*;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use util::*;

static STOP: AtomicBool = AtomicBool::new(false);
static OUT: Mutex<()> = Mutex::new(());

fn send(v: Value) {
    let _g = OUT.lock().unwrap_or_else(|e| e.into_inner());
    let mut o = std::io::stdout().lock();
    if writeln!(o, "{}", v).is_err() || o.flush().is_err() { shutdown(0); }
}

fn shutdown(code: i32) -> ! {
    tasks::shutdown_all();
    std::process::exit(code);
}

fn cap_response(t: String) -> String {
    let n = chars_len(&t);
    if n <= RESPONSE_CAP { return t; }
    format!("{}\n…[{} characters omitted to stay within the tool-output limit; narrow the request]…\n{}", first_chars(&t, RESPONSE_CAP * 6 / 10), n - RESPONSE_CAP, last_chars(&t, RESPONSE_CAP * 4 / 10))
}

fn call_tool(name: &str, a: &Value) -> Result<String, String> {
    match name {
        "opencode_start" => tasks::start(a),
        "opencode_policy" => policy::policy_text(a),
        "opencode_status" => { let t = tasks::get(&a["id"])?; let t = t.lock().unwrap(); Ok(tasks::status_text(&t)) }
        "opencode_result" => { let t = tasks::get(&a["id"])?; let t = t.lock().unwrap(); Ok(tasks::result_text(&t, a)) }
        "opencode_cancel" => { let t = tasks::get(&a["id"])?; Ok(tasks::cancel(&t)) }
        "opencode_list" => Ok(tasks::list_text()),
        "opencode_sessions" => sessions::sessions(a),
        "opencode_session_output" => sessions::session_output(a),
        "opencode_session_rename" => sessions::rename(a),
        "opencode_processes" => procs::processes(),
        _ => Err("unknown tool".into()),
    }
}

fn handle_call(id: Value, m: Value) {
    let name = match &m["params"]["name"] { Value::String(s) => s.clone(), Value::Null => String::new(), o => o.to_string() };
    let args = match &m["params"]["arguments"] { Value::Object(_) => m["params"]["arguments"].clone(), _ => json!({}) };
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call_tool(&name, &args))).unwrap_or_else(|_| Err("internal error".into()));
    match res {
        Ok(t) => send(json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": cap_response(t)}]}})),
        Err(e) => send(json!({"jsonrpc": "2.0", "id": id, "result": {"isError": true, "content": [{"type": "text", "text": cap_response(e)}]}})),
    }
}

extern "C" fn on_signal(_: libc::c_int) { STOP.store(true, Ordering::SeqCst); }

fn main() {
    let _ = texts(); // parse the embedded texts (and fail early if broken)
    unsafe { for s in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] { libc::signal(s, on_signal as *const () as usize); } }
    std::thread::spawn(|| loop { std::thread::sleep(std::time::Duration::from_millis(50)); if STOP.load(Ordering::SeqCst) { shutdown(0); } });
    let stdin = std::io::stdin();
    let mut rd = stdin.lock();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match rd.read_until(b'\n', &mut buf) { Ok(0) | Err(_) => break, Ok(_) => {} }
        let m: Value = match serde_json::from_str(String::from_utf8_lossy(&buf).trim()) { Ok(v) => v, Err(_) => continue };
        if !m.is_object() { continue; }
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
    shutdown(0);
}
