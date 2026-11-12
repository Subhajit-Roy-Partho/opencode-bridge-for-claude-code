// Small helpers shared by all modules: JS-like number coercion, text clipping, time formatting, URL encoding.
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// JS `Number(v)` for the JSON value kinds that can occur (NaN when not numeric).
pub fn to_f64(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else { t.parse::<f64>().unwrap_or(f64::NAN) }
        }
        Value::Bool(b) => if *b { 1.0 } else { 0.0 },
        Value::Null => 0.0,
        _ => f64::NAN,
    }
}

/// server.mjs `num(v, d, lo, hi)`: missing / empty / non-numeric -> default, otherwise clamped.
pub fn num(v: Option<&Value>, d: f64, lo: f64, hi: f64) -> f64 {
    match v {
        None | Some(Value::Null) => d,
        Some(Value::String(s)) if s.is_empty() => d,
        Some(x) => {
            let n = to_f64(x);
            if n.is_finite() { n.max(lo).min(hi) } else { d }
        }
    }
}

pub fn num_env(name: &str, d: f64, lo: f64, hi: f64) -> f64 {
    match std::env::var(name) {
        Ok(s) => num(Some(&Value::String(s)), d, lo, hi),
        Err(_) => d,
    }
}

/// JS `Number(v) || d` (NaN and 0 fall back to the default).
pub fn num_or(v: Option<&Value>, d: f64) -> f64 {
    match v {
        None => d,
        Some(x) => { let n = to_f64(x); if n.is_finite() && n != 0.0 { n } else { d } }
    }
}

/// JS `String(v)` for the values an argument can hold; None for missing / null.
pub fn arg_str(a: &Value, key: &str) -> Option<String> {
    match a.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Bool(b)) => Some(b.to_string()),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(other) => Some(other.to_string()),
    }
}

pub fn chars_len(s: &str) -> usize { s.chars().count() }

/// Collapse whitespace, trim, cut to `n` characters with an ellipsis (server.mjs `clip`).
pub fn clip(s: &str, n: usize) -> String {
    let joined = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = joined.chars().collect();
    if chars.len() > n {
        let mut o: String = chars[..n.saturating_sub(1)].iter().collect();
        o.push('…');
        o
    } else { joined }
}

pub fn pad_end(s: &str, n: usize) -> String { let l = chars_len(s); if l >= n { s.to_string() } else { format!("{}{}", s, " ".repeat(n - l)) } }
pub fn pad_start(s: &str, n: usize) -> String { let l = chars_len(s); if l >= n { s.to_string() } else { format!("{}{}", " ".repeat(n - l), s) } }

/// Keep only the last `n` characters of `s`.
pub fn keep_last_chars(s: &mut String, n: usize) {
    let l = chars_len(s);
    if l > n {
        let skip = l - n;
        let idx = s.char_indices().nth(skip).map(|(i, _)| i).unwrap_or(0);
        s.drain(..idx);
    }
}
pub fn last_chars(s: &str, n: usize) -> String { let l = chars_len(s); if l <= n { s.to_string() } else { s.chars().skip(l - n).collect() } }
pub fn first_chars(s: &str, n: usize) -> String { s.chars().take(n).collect() }

/// `HH:MM:SS` in local time (JS toLocaleTimeString('en-GB')).
pub fn hms(ms: i64) -> String {
    unsafe {
        let t = (ms / 1000) as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        format!("{:02}:{:02}:{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec)
    }
}

pub fn ago(ms: i64) -> String {
    let m = (now_ms() - ms) as f64 / 60000.0;
    if m < 1.0 { "<1m".into() }
    else if m < 90.0 { format!("{}m", js_round(m)) }
    else if m < 2880.0 { format!("{:.1}h", m / 60.0) }
    else { format!("{:.1}d", m / 1440.0) }
}
pub fn js_round(x: f64) -> i64 { (x + 0.5).floor() as i64 }

pub fn k(n: f64) -> String {
    if n >= 1e6 { format!("{:.1}M", n / 1e6) } else if n >= 1e3 { format!("{}k", js_round(n / 1e3)) } else { format!("{}", n as i64) }
}

/// Last `n` components of a path.
pub fn tail_path(p: &str, n: usize) -> String {
    let parts: Vec<&str> = p.split('/').filter(|x| !x.is_empty()).collect();
    let start = parts.len().saturating_sub(n);
    parts[start..].join("/")
}

/// Strip control characters, collapse whitespace, cap at 200 characters (server.mjs `cleanTitle`).
pub fn clean_title(s: &str) -> String {
    let no_ctl: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let joined = no_ctl.split_whitespace().collect::<Vec<_>>().join(" ");
    first_chars(&joined, 200)
}

/// `err.message`-style text of a JSON error value (server.mjs `errText`).
pub fn err_text(e: &Value) -> String {
    match e {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Object(o) => {
            let ty = o.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let msg = o.get("message").and_then(|v| v.as_str()).map(|s| s.to_string())
                .or_else(|| o.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .unwrap_or_else(|| e.to_string());
            [ty.to_string(), msg].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(": ")
        }
        other => other.to_string(),
    }
}

fn enc(s: &str, keep: &str, space_plus: bool) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        let c = b as char;
        if c.is_ascii_alphanumeric() || keep.contains(c) { o.push(c); }
        else if c == ' ' && space_plus { o.push('+'); }
        else { o.push_str(&format!("%{:02X}", b)); }
    }
    o
}
/// URLSearchParams encoding (space -> '+').
pub fn enc_query(s: &str) -> String { enc(s, "*-._", true) }
/// encodeURIComponent.
pub fn enc_component(s: &str) -> String { enc(s, "-_.!~*'()", false) }
