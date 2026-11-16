// Shared service-session helpers used by the bridge (snap/reconcile) and the runner (re-attach):
// sessionState, reattach, active_ids, last_assistant_text, build_args, signal names (server.mjs).
use crate::api::api;
use crate::config::*;
use crate::util::*;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;

fn re(cell: &'static OnceLock<regex::Regex>, src: &str) -> &'static regex::Regex {
    cell.get_or_init(|| regex::RegexBuilder::new(src).case_insensitive(true).build().unwrap())
}

pub fn auto_abort(s: &str) -> bool {
    static R: OnceLock<regex::Regex> = OnceLock::new();
    re(&R, r"aborted|session interrupted").is_match(s)
}

pub fn sig_name(n: i32) -> String {
    match n {
        1 => "SIGHUP", 2 => "SIGINT", 3 => "SIGQUIT", 4 => "SIGILL", 6 => "SIGABRT",
        8 => "SIGFPE", 9 => "SIGKILL", 11 => "SIGSEGV", 13 => "SIGPIPE", 14 => "SIGALRM",
        15 => "SIGTERM", _ => return format!("signal {}", n),
    }
    .to_string()
}

/// argv of one attempt: head + (-s sessionID | --title title) + (-f attachFile)? + message
pub fn build_args(t: &Value, session_id: Option<&str>, message: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = t["head"].as_array().cloned().unwrap_or_default().iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
    if let Some(s) = session_id.filter(|s| !s.is_empty()) {
        a.push("-s".into());
        a.push(s.to_string());
    } else {
        a.push("--title".into());
        a.push(t["title"].as_str().unwrap_or("").to_string());
    }
    if let Some(f) = t["attachFile"].as_str().filter(|s| !s.is_empty()) {
        a.push("-f".into());
        a.push(f.to_string());
    }
    a.push(message.unwrap_or_else(|| t["message"].as_str().unwrap_or("")).to_string());
    a
}

/// Newest-first messages (as the API returns them) -> last assistant text.
pub fn last_assistant_text(msgs: &[Value]) -> String {
    for m in msgs {
        if m.get("type").and_then(|v| v.as_str()) != Some("assistant") { continue; }
        let tx = m.get("content").and_then(|v| v.as_array()).cloned().unwrap_or_default().iter()
            .filter(|b| b.get("type").and_then(|v| v.as_str()) == Some("text") && b.get("text").and_then(|v| v.as_str()).map(|x| !x.is_empty()).unwrap_or(false))
            .map(|b| b.get("text").and_then(|v| v.as_str()).unwrap_or("").trim().to_string()).collect::<Vec<_>>().join("\n");
        if !tx.is_empty() { return tx; }
    }
    String::new()
}

pub fn active_ids() -> HashSet<String> {
    let mut out = HashSet::new();
    if let Ok(r) = api("GET", "/api/session/active", &[], None) {
        let d = if r.get("data").map(|x| !x.is_null()).unwrap_or(false) { r["data"].clone() } else { r };
        match d {
            Value::Array(a) => for x in a {
                if let Some(s) = x.as_str() { out.insert(s.into()); }
                else if let Some(s) = x.get("id").and_then(|v| v.as_str()).or_else(|| x.get("sessionID").and_then(|v| v.as_str())) { out.insert(s.into()); }
            },
            Value::Object(o) => for k in o.keys() { out.insert(k.clone()); },
            _ => {}
        }
    }
    out
}

/// One consistent look at a session: its record and whether the service is running it.
pub fn session_state(sid: &str) -> Result<(Option<Value>, bool), String> {
    let r = api("GET", &format!("/api/session/{}", enc_component(sid)), &[], None)?;
    let mut s = if r.get("data").map(|x| !x.is_null()).unwrap_or(false) { r["data"].clone() } else { r };
    let active = active_ids().contains(sid);
    if !active && s.is_object() && s.get("outcome").and_then(|v| v.as_str()).filter(|o| !o.is_empty()).is_none() {
        let r2 = api("GET", &format!("/api/session/{}", enc_component(sid)), &[], None)?;
        s = if r2.get("data").map(|x| !x.is_null()).unwrap_or(false) { r2["data"].clone() } else { r2 };
    }
    Ok((Some(s), active))
}

pub struct Reattached { pub outcome: String, pub text: String, pub error: String }

/// Poll the service for a session whose client is gone. Returns None when the session cannot be found
/// (or on persistent lookup failure), or when stop() / the deadline says to give up.
pub fn reattach<F>(sid: &str, deadline: i64, stop: F) -> Option<Reattached>
where F: Fn() -> bool {
    let mut fails = 0u32;
    let mut first = true;
    loop {
        let st = session_state(sid);
        match st {
            Err(_) => {
                if first || { fails += 1; fails >= 3 } { return None; }
                std::thread::sleep(Duration::from_millis(cfg().reattach_poll_ms));
                continue;
            }
            Ok((s, active)) => {
                fails = 0;
                first = false;
                let s = match s { Some(v) if v.is_object() => v, _ => return None };
                let outcome = s.get("outcome").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if !active && !outcome.is_empty() {
                    let mut text = String::new();
                    let mut error = String::new();
                    if let Ok(m) = api("GET", &format!("/api/session/{}/message", enc_component(sid)), &[("limit", "40".to_string())], None) {
                        let data: Vec<Value> = m.get("data").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                        text = last_assistant_text(&data);
                        if let Some(e) = data.iter().map(|x| &x["error"]).find(|e| !e.is_null() && *e != &Value::Bool(false) && *e != &Value::String(String::new())) {
                            error = err_text(e);
                        }
                    }
                    return Some(Reattached { outcome, text, error });
                }
                if !active {
                    let upd = s.get("time").and_then(|v| v.get("updated")).and_then(|v| v.as_i64())
                        .or_else(|| s.get("time").and_then(|v| v.get("created")).and_then(|v| v.as_i64())).unwrap_or(0);
                    if now_ms() - upd > cfg().reattach_quiet_ms {
                        return Some(Reattached { outcome: "interrupted".into(), text: String::new(), error: String::new() });
                    }
                }
                if stop() || now_ms() > deadline { return None; }
                std::thread::sleep(Duration::from_millis(cfg().reattach_poll_ms));
            }
        }
    }
}
