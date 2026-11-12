// Read-only view of every opencode session (list, output) plus rename: all through `opencode api`.
use crate::api::api;
use crate::config::*;
use crate::util::*;
use serde_json::Value;
use std::collections::HashSet;

fn truthy(v: &Value) -> bool { match v { Value::Null => false, Value::Bool(b) => *b, Value::String(s) => !s.is_empty(), Value::Number(n) => n.as_f64().map(|x| x != 0.0).unwrap_or(true), _ => true } }

fn upd_of(s: &Value) -> i64 { s["time"]["updated"].as_f64().or_else(|| s["time"]["created"].as_f64()).unwrap_or(0.0) as i64 }

fn state_of(s: &Value, active: &HashSet<String>) -> String {
    if let Some(o) = s["outcome"].as_str().filter(|o| !o.is_empty()) { return o.to_string(); }
    if s["id"].as_str().map(|i| active.contains(i)).unwrap_or(false) { return "running".into(); }
    if (now_ms() - upd_of(s)) as f64 / 60000.0 > stale_min() { "stale?".into() } else { "running".into() }
}

fn active_ids() -> HashSet<String> {
    let mut out = HashSet::new();
    if let Ok(r) = api("GET", "/api/session/active", &[], None) {
        let d = if r.get("data").map(|x| !x.is_null()).unwrap_or(false) { r["data"].clone() } else { r };
        match d {
            Value::Array(a) => for x in a { if let Some(s) = x.as_str() { out.insert(s.into()); } else if let Some(s) = x["id"].as_str().or_else(|| x["sessionID"].as_str()) { out.insert(s.into()); } },
            Value::Object(o) => for k in o.keys() { out.insert(k.clone()); },
            _ => {}
        }
    }
    out
}

pub fn sessions(a: &Value) -> Result<String, String> {
    let limit = num_or(a.get("limit"), 25.0).max(1.0).min(200.0) as usize;
    let want = arg_str(a, "state").filter(|s| !s.is_empty()).unwrap_or_else(|| "all".into()).to_lowercase();
    let run_only = want == "running" || want == "active";
    let want_state = if want == "stale" { "stale?".to_string() } else { want.clone() };
    let since_min = a.get("since_minutes").map(to_f64).filter(|x| x.is_finite() && *x != 0.0);
    let since = since_min.map(|m| now_ms() - (m * 60000.0) as i64).unwrap_or(0);
    let stop_before = std::cmp::max(since, if run_only { now_ms() - (stale_min() * 60000.0) as i64 } else { 0 });
    let act = active_ids();
    let mut unseen: HashSet<String> = act.clone();
    let agent_f = arg_str(a, "agent").filter(|s| !s.is_empty());
    let dir_f = arg_str(a, "directory").filter(|s| !s.is_empty());
    let prefix_f = arg_str(a, "title_prefix").filter(|s| !s.is_empty());
    let search = arg_str(a, "search").filter(|s| !s.is_empty()).or_else(|| prefix_f.clone());
    let no_children = matches!(a.get("children"), Some(Value::Bool(false)));
    let mut rows: Vec<(Value, String, i64)> = vec![];
    let (mut cursor, mut pages, mut scanned, mut partial) = (None::<String>, 0usize, 0usize, false);
    let deadline = now_ms() + cfg().scan_deadline_ms as i64;
    while rows.len() < limit && pages < 15 {
        if pages > 0 && now_ms() > deadline { partial = true; break; }
        let mut q: Vec<(&str, String)> = vec![("limit", "100".into())];
        if let Some(s) = &search { q.push(("search", s.clone())); }
        if let Some(c) = &cursor { q.push(("cursor", c.clone())); }
        let r = api("GET", "/api/session", &q, None)?;
        let data: Vec<Value> = r["data"].as_array().cloned().unwrap_or_default();
        scanned += data.len();
        for s in &data {
            if let Some(i) = s["id"].as_str() { unseen.remove(i); }
            let st = state_of(s, &act);
            let upd = upd_of(s);
            if run_only { if st != "running" { continue; } }
            else if want == "finished" { if st == "running" || st == "stale?" { continue; } }
            else if want_state != "all" && st != want_state { continue; }
            if since != 0 && upd < since && !(run_only && st == "running") { continue; }
            if let Some(ag) = &agent_f { if s["agent"].as_str() != Some(ag.as_str()) { continue; } }
            if let Some(d) = &dir_f { if !s["location"]["directory"].as_str().unwrap_or("").contains(d.as_str()) { continue; } }
            if let Some(p) = &prefix_f { if !s["title"].as_str().unwrap_or("").starts_with(p.as_str()) { continue; } }
            if no_children && truthy(&s["parentID"]) { continue; }
            rows.push((s.clone(), st, upd));
            if rows.len() >= limit { break; }
        }
        if stop_before != 0 && !data.is_empty() && upd_of(data.last().unwrap()) < stop_before && (unseen.is_empty() || search.is_some()) { break; }
        cursor = r["cursor"]["next"].as_str().map(|s| s.to_string());
        if cursor.is_none() || data.is_empty() { break; }
        pages += 1;
    }
    let mut head = format!("{} session(s) (state={}{}{}{}{}); scanned {}; service-active ids: {}", rows.len(), want,
        agent_f.as_ref().map(|x| format!(", agent={}", x)).unwrap_or_default(), dir_f.as_ref().map(|x| format!(", dir~{}", x)).unwrap_or_default(),
        prefix_f.as_ref().map(|x| format!(", title^={}", x)).unwrap_or_default(),
        a.get("since_minutes").filter(|_| since_min.is_some()).map(|v| format!(", last {}m", match v { Value::String(s) => s.clone(), o => o.to_string() })).unwrap_or_default(), scanned, act.len());
    if partial { head.push_str(&format!("; PARTIAL: time limit ({} s) reached after {} page(s), narrow the filters", js_round(cfg().scan_deadline_ms as f64 / 1000.0), pages)); }
    if rows.is_empty() { return Ok(head); }
    let lines: Vec<String> = rows.iter().map(|(s, st, upd)| {
        let tok = format!("{}/{}", k(s["tokens"]["input"].as_f64().unwrap_or(0.0)), k(s["tokens"]["output"].as_f64().unwrap_or(0.0)));
        format!("{}  {} {} {} ago  {} tok  {} {}{}", s["id"].as_str().unwrap_or(""), pad_end(st, 11), pad_end(s["agent"].as_str().filter(|x| !x.is_empty()).unwrap_or("-"), 13),
            pad_start(&ago(*upd), 5), pad_start(&tok, 9), pad_end(&tail_path(s["location"]["directory"].as_str().unwrap_or(""), 2), 30),
            if truthy(&s["parentID"]) { "↳ " } else { "" }, clip(s["title"].as_str().unwrap_or(""), 90))
    }).collect();
    Ok(format!("{}\n{}", head, lines.join("\n")))
}

fn render_message(m: &Value, tool_chars: usize) -> Vec<String> {
    let created = m["time"]["created"].as_f64().filter(|x| *x != 0.0);
    let t = created.map(|c| hms(c as i64)).unwrap_or_default();
    let ty = m["type"].as_str().unwrap_or("");
    if ty == "idle" {
        let mut v = vec![format!("[{}] — idle{} —", t, m["outcome"].as_str().filter(|o| !o.is_empty()).map(|o| format!(" ({})", o)).unwrap_or_default())];
        if truthy(&m["error"]) { v.push(format!("  ✖ error: {}", clip(&err_text(&m["error"]), 400))); }
        return v;
    }
    if ty == "agent-switched" { return vec![format!("[{}] agent → {}", t, m["agent"].as_str().unwrap_or("undefined"))]; }
    if m["text"].is_string() && m["content"].is_null() { return vec![format!("[{}] {}: {}", t, ty, clip(m["text"].as_str().unwrap_or(""), 1500))]; }
    let mut out = vec![];
    if truthy(&m["error"]) { out.push(format!("[{}] ✖ error: {}", t, clip(&err_text(&m["error"]), 400))); }
    if m["finish"].as_str() == Some("length") { out.push(format!("[{}] ⚠ output token limit hit in this step (finish=length)", t)); }
    for b in m["content"].as_array().cloned().unwrap_or_default() {
        match b["type"].as_str() {
            Some("text") if b["text"].as_str().map(|x| !x.is_empty()).unwrap_or(false) => out.push(format!("[{}] {}: {}", t, ty, b["text"].as_str().unwrap().trim())),
            Some("tool") => {
                let st = &b["state"];
                let inp = match &st["input"] { Value::String(s) => s.clone(), Value::Null => "{}".to_string(), o => serde_json::to_string(o).unwrap_or_default() };
                let raw = if !st["content"].is_null() { &st["content"] } else if !st["error"].is_null() { &st["error"] } else { &st["output"] };
                let res = match raw {
                    Value::Array(a) => a.iter().map(|x| x["text"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>().join(" "),
                    Value::Object(_) => serde_json::to_string(raw).unwrap_or_default(),
                    Value::String(s) => s.clone(), Value::Null => String::new(), o => o.to_string(),
                };
                out.push(format!("  → {}({}) [{}]{}", b["name"].as_str().unwrap_or("undefined"), clip(&inp, tool_chars), st["status"].as_str().unwrap_or("undefined"),
                    if res.is_empty() { String::new() } else { format!(" ⇒ {}", clip(&res, tool_chars)) }));
            }
            _ => {}
        }
    }
    out
}

pub fn session_output(a: &Value) -> Result<String, String> {
    let mode = arg_str(a, "mode").filter(|s| !s.is_empty()).unwrap_or_else(|| "tail".into()).to_lowercase();
    let nmsg = num_or(a.get("messages"), if mode == "last" { 20.0 } else { 12.0 }).max(1.0).min(200.0) as usize;
    let cap = num_or(a.get("max_chars"), 6000.0).max(500.0).min(60000.0) as usize;
    let tool_chars = num_or(a.get("tool_chars"), 220.0).max(40.0).min(2000.0) as usize;
    let id = enc_component(&arg_str(a, "id").unwrap_or_else(|| "undefined".into()));
    let sr = api("GET", &format!("/api/session/{}", id), &[], None)?;
    let mr = api("GET", &format!("/api/session/{}/message", id), &[("limit", nmsg.to_string())], None)?;
    let act = active_ids();
    let s = if sr.get("data").map(|x| !x.is_null()).unwrap_or(false) { sr["data"].clone() } else { sr };
    let mut msgs: Vec<Value> = mr["data"].as_array().cloned().unwrap_or_default();
    let newest_first = msgs.clone();
    msgs.reverse();
    let st = state_of(&s, &act);
    let fail_raw = newest_first.iter().map(|m| &m["error"]).find(|e| truthy(e));
    let failure = fail_raw.map(|e| { let msg = err_text(e); let c = classify(&msg); format!("\nfailure: {}: {}{}", c.kind, clip(&msg, 300), if c.advice.is_empty() { String::new() } else { format!("\nadvice: {}", c.advice) }) }).unwrap_or_default();
    let tok = |key: &str| k(s["tokens"][key].as_f64().unwrap_or(0.0));
    let head = format!("{}  {}  {}  updated {} ago  {}/{} tok\n{}  |  {}{}", s["id"].as_str().unwrap_or("undefined"), st, s["agent"].as_str().unwrap_or("undefined"), ago(upd_of(&s)), tok("input"), tok("output"),
        tail_path(s["location"]["directory"].as_str().unwrap_or(""), 4), s["title"].as_str().unwrap_or("undefined"), failure);
    let mut body: String;
    if mode == "last" {
        let mut last = String::new();
        for m in msgs.iter().rev() {
            if m["type"].as_str() != Some("assistant") { continue; }
            let tx = m["content"].as_array().cloned().unwrap_or_default().iter().filter(|b| b["type"].as_str() == Some("text") && b["text"].as_str().map(|x| !x.is_empty()).unwrap_or(false))
                .map(|b| b["text"].as_str().unwrap().trim().to_string()).collect::<Vec<_>>().join("\n");
            if !tx.is_empty() { last = tx; break; }
        }
        body = if last.is_empty() { format!("(no assistant text in the last {} messages; use mode=tail to see the tool calls)", msgs.len()) } else { last };
    } else {
        let lines: Vec<String> = msgs.iter().flat_map(|m| render_message(m, tool_chars)).collect();
        body = if lines.is_empty() { "(no messages)".into() } else { lines.join("\n") };
    }
    if chars_len(&body) > cap { body = format!("…[cut]\n{}", last_chars(&body, cap)); }
    Ok(format!("{}\n{}\n{}", head, "-".repeat(40), body))
}

pub fn rename(a: &Value) -> Result<String, String> {
    let clean = clean_title(&arg_str(a, "title").unwrap_or_default());
    if clean.is_empty() { return Err("title is empty".into()); }
    let id_raw = arg_str(a, "id").unwrap_or_default();
    if id_raw.trim().is_empty() { return Err("id is required".into()); }
    let id = enc_component(&id_raw);
    let body: Value = serde_json::json!({ "title": clean });
    api("PATCH", &format!("/api/session/{}", id), &[], Some(&body))?;
    let r = api("GET", &format!("/api/session/{}", id), &[], None)?;
    let title = r["data"]["title"].as_str().unwrap_or("undefined").to_string();
    let ok = regex::Regex::new(r"^[A-Za-z0-9._-]+/[a-z-]+: .+").unwrap().is_match(&title);
    Ok(format!("title is now: {}{}", title, if ok { "" } else { "\nnote: does not match the convention \"<LANE>/<agent>: <task>\"" }))
}
