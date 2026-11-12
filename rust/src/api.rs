// `opencode api METHOD /path?query [-d json]`: the only way the bridge talks to the opencode service (it handles authentication).
use crate::config::*;
use crate::util::*;
use regex::Regex;
use serde_json::Value;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

const MAX_BUFFER: usize = 64 * 1024 * 1024;

pub struct ApiErr { pub msg: String, pub transient: bool }
impl ApiErr { fn new(m: String) -> Self { ApiErr { msg: m, transient: false } } }

enum Fail { NotFound, TooLarge, Timeout, Exit }

fn re(cell: &'static OnceLock<Regex>, src: &str) -> &'static Regex { cell.get_or_init(|| regex::RegexBuilder::new(src).case_insensitive(true).build().unwrap()) }

fn api_error(method: &str, path: &str, fail: Fail, stderr: &str) -> ApiErr {
    static LINE: OnceLock<Regex> = OnceLock::new();
    static DOWN: OnceLock<Regex> = OnceLock::new();
    static RESET: OnceLock<Regex> = OnceLock::new();
    static AUTH: OnceLock<Regex> = OnceLock::new();
    let raw = stderr.trim();
    let line_re = LINE.get_or_init(|| Regex::new(r"^Error:|HTTP \d{3}").unwrap());
    let line = raw.lines().map(|l| l.trim()).find(|l| line_re.is_match(l)).map(|s| s.to_string())
        .or_else(|| raw.lines().find(|l| !l.trim().is_empty()).map(|s| s.trim().to_string())).unwrap_or_default();
    let c = cfg();
    let (msg, transient) = match fail {
        Fail::NotFound => ("the opencode binary was not found on PATH (install opencode >= 2 and make sure the process running the bridge has it on PATH)".to_string(), false),
        Fail::TooLarge => ("the reply was too large (> 64 MB): ask for fewer messages / a smaller limit".to_string(), false),
        Fail::Timeout => (format!("timed out after {} (the opencode service is busy or hung; retry, or restart it)", if c.api_timeout_ms >= 1000 { format!("{} s", js_round(c.api_timeout_ms as f64 / 1000.0)) } else { format!("{} ms", c.api_timeout_ms) }), true),
        Fail::Exit => {
            if re(&DOWN, r"ECONNREFUSED|Could not reach server|ECONNRESET|EPIPE").is_match(raw) {
                (format!("the opencode background service is not reachable (is it running? start opencode once, or run `opencode service` ...). {}", clip(&line, 160)), re(&RESET, r"ECONNRESET|EPIPE").is_match(raw))
            } else if re(&AUTH, r"Authentication required|\b401\b|Unauthorized").is_match(raw) {
                (format!("authentication was refused by the opencode service ({})", clip(&line, 120)), false)
            } else {
                (clip(if line.is_empty() { "unknown error" } else { &line }, 240), false)
            }
        }
    };
    ApiErr { msg: format!("opencode api {} {} failed: {}", method, path, msg), transient }
}

fn api_once(method: &str, path: &str, query: &[(&str, String)], body: Option<&Value>) -> Result<Value, ApiErr> {
    let q = query.iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| format!("{}={}", enc_query(k), enc_query(v))).collect::<Vec<_>>().join("&");
    let mut args = vec!["api".to_string(), method.to_string(), if q.is_empty() { path.to_string() } else { format!("{}?{}", path, q) }];
    if let Some(b) = body { args.push("-d".into()); args.push(b.to_string()); }
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| "/".into());
    let mut child = match Command::new("opencode").args(&args).env("PWD", cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(_) => return Err(api_error(method, path, Fail::NotFound, "")),
    };
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let (tx, rx) = mpsc::channel::<(Vec<u8>, bool)>();
    std::thread::spawn(move || {
        let mut buf = Vec::new(); let mut chunk = vec![0u8; 65536]; let mut over = false;
        loop {
            match so.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => { buf.extend_from_slice(&chunk[..n]); if buf.len() > MAX_BUFFER { over = true; break; } }
            }
        }
        let _ = tx.send((buf, over));
    });
    let (etx, erx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut b = Vec::new(); let mut chunk = vec![0u8; 8192];
        loop { match se.read(&mut chunk) { Ok(0) | Err(_) => break, Ok(n) => { if b.len() < 65536 { b.extend_from_slice(&chunk[..n]); } } } }
        let _ = etx.send(String::from_utf8_lossy(&b).to_string());
    });
    match rx.recv_timeout(Duration::from_millis(cfg().api_timeout_ms)) {
        Err(_) => { let _ = child.kill(); let _ = child.wait(); return Err(api_error(method, path, Fail::Timeout, "")); }
        Ok((buf, over)) => {
            if over { let _ = child.kill(); let _ = child.wait(); return Err(api_error(method, path, Fail::TooLarge, "")); }
            let status = child.wait();
            let stderr = erx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
            if !status.map(|s| s.success()).unwrap_or(false) { return Err(api_error(method, path, Fail::Exit, &stderr)); }
            let s = String::from_utf8_lossy(&buf).trim().to_string();
            if s.is_empty() { return Ok(Value::Object(Default::default())); }
            serde_json::from_str(&s).map_err(|_| ApiErr::new(format!("opencode api {} {} failed: non-JSON reply: {}", method, path, clip(&s, 200))))
        }
    }
}

/// Reads are repeated once after a transient failure; writes never.
pub fn api(method: &str, path: &str, query: &[(&str, String)], body: Option<&Value>) -> Result<Value, String> {
    match api_once(method, path, query, body) {
        Ok(v) => Ok(v),
        Err(e) if method == "GET" && e.transient => {
            std::thread::sleep(Duration::from_millis(400));
            api_once(method, path, query, body).map_err(|e| e.msg)
        }
        Err(e) => Err(e.msg),
    }
}
