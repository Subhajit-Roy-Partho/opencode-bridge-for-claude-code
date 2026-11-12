// Run-time configuration read once from the environment (same variables and defaults as server.mjs), and the embedded texts.
use crate::util::*;
use regex::RegexBuilder;
use serde_json::Value;
use std::path::Path;
use std::sync::OnceLock;

pub const VERSION: &str = "0.5.0";
pub const MAX_TEXT: usize = 2_000_000;
pub const ARG_LIMIT: usize = 100_000;
pub const PROMPT_MAX: usize = 5_000_000;
pub const RESULT_CAP: usize = 60_000;
pub const RESPONSE_CAP: usize = 100_000;
pub const KEEP_FINISHED: usize = 200;
pub const WORKER_CONFIG: &str = r#"{"agent":{"worker":{"mode":"primary","description":"Direct implementer: does the work itself, never delegates","prompt":"You are a direct implementer. Do all work yourself with your own file and shell tools. Never launch sub-agents or tasks. Do not end your turn until the work is finished and verified.","permission":{"task":"deny"}}}}"#;

pub struct Config {
    pub model: String,
    pub root: String,
    pub max_parallel: usize,
    pub default_timeout_min: f64,
    pub max_retries: u32,
    pub retry_delay_ms: u64,
    pub api_timeout_ms: u64,
    pub scan_deadline_ms: u64,
    pub kill_grace_ms: u64,
    pub timeout_unit_ms: u64,
    pub procfs: bool,
}

pub fn cfg() -> &'static Config {
    static C: OnceLock<Config> = OnceLock::new();
    C.get_or_init(|| {
        let root_raw = std::env::var("OPENCODE_BRIDGE_ROOT").ok().filter(|s| !s.is_empty())
            .unwrap_or_else(|| std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| "/".into()));
        let root = std::fs::canonicalize(&root_raw).map(|p| p.to_string_lossy().to_string()).unwrap_or(root_raw);
        Config {
            model: std::env::var("OPENCODE_BRIDGE_MODEL").unwrap_or_default(),
            root,
            max_parallel: num_env("OPENCODE_BRIDGE_MAX_PARALLEL", 6.0, 1.0, 64.0) as usize,
            default_timeout_min: num_env("OPENCODE_BRIDGE_TIMEOUT_MIN", 120.0, 1.0, 1440.0),
            max_retries: num_env("OPENCODE_BRIDGE_RETRIES", 2.0, 0.0, 5.0) as u32,
            retry_delay_ms: (num_env("OPENCODE_BRIDGE_RETRY_DELAY_S", 20.0, 0.0, 600.0) * 1000.0) as u64,
            api_timeout_ms: num_env("OPENCODE_BRIDGE_API_TIMEOUT_MS", 45000.0, 200.0, 600000.0) as u64,
            scan_deadline_ms: num_env("OPENCODE_BRIDGE_SCAN_DEADLINE_MS", 35000.0, 200.0, 600000.0) as u64,
            kill_grace_ms: num_env("OPENCODE_BRIDGE_KILL_GRACE_MS", 5000.0, 50.0, 60000.0) as u64,
            timeout_unit_ms: num_env("OPENCODE_BRIDGE_TIMEOUT_UNIT_MS", 60000.0, 10.0, 60000.0) as u64,
            procfs: std::env::var("OPENCODE_BRIDGE_PROCFS").map(|v| v != "0").unwrap_or(true) && Path::new("/proc/self/cmdline").exists(),
        }
    })
}

pub struct Kind { pub kind: String, pub transient: bool, pub re: regex::Regex, pub advice: String }

pub struct Texts {
    pub raw: Value,
    pub kinds: Vec<Kind>,
    pub secrets: Vec<(regex::Regex, String)>,
    pub read_only: Vec<String>,
    pub editors: Vec<String>,
    pub roster: Vec<(String, String)>,
    pub tools: Value,
}

fn build_re(src: &str, flags: &str) -> regex::Regex {
    RegexBuilder::new(src).case_insensitive(flags.contains('i')).build().unwrap_or_else(|e| panic!("bad pattern {}: {}", src, e))
}

pub fn texts() -> &'static Texts {
    static T: OnceLock<Texts> = OnceLock::new();
    T.get_or_init(|| {
        let raw: Value = serde_json::from_str(include_str!("../data/texts.json")).expect("texts.json");
        let kinds = raw["kinds"].as_array().unwrap().iter().map(|k| Kind {
            kind: k[0].as_str().unwrap().to_string(), transient: k[1].as_bool().unwrap(), re: build_re(k[2].as_str().unwrap(), k[3].as_str().unwrap()), advice: k[4].as_str().unwrap().to_string(),
        }).collect();
        let secrets = raw["secrets"].as_array().unwrap().iter().map(|k| (build_re(k[0].as_str().unwrap(), k[1].as_str().unwrap()), k[0].as_str().unwrap().to_string())).collect();
        let strs = |key: &str| raw[key].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect::<Vec<_>>();
        let roster = raw["roster"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect();
        // the model default and the timeout default are sentinels in the exported schema
        let c = cfg();
        let model_txt = if c.model.is_empty() { "opencode's own default (set OPENCODE_BRIDGE_MODEL to change)".to_string() } else { c.model.clone() };
        let tools_s = serde_json::to_string(&raw["tools"]).unwrap().replace("@@MODEL@@", &model_txt.replace('\\', "\\\\").replace('"', "\\\""))
            .replace("default 1234 (1-1440)", &format!("default {} (1-1440)", c.default_timeout_min));
        let tools: Value = serde_json::from_str(&tools_s).unwrap();
        Texts { read_only: strs("readOnly"), editors: strs("editors"), kinds, secrets, roster, tools, raw }
    })
}

pub fn txt(key: &str) -> &'static str { texts().raw[key].as_str().unwrap_or("") }
pub fn is_read_only(agent: &str) -> bool { texts().read_only.iter().any(|a| a == agent) }
pub fn is_editor(agent: &str) -> bool { texts().editors.iter().any(|a| a == agent) }
pub fn roster_has(agent: &str) -> bool { texts().roster.iter().any(|(a, _)| a == agent) }
pub fn stale_min() -> f64 { texts().raw["staleMin"].as_f64().unwrap_or(45.0) }

pub struct Class { pub kind: String, pub transient: bool, pub advice: String }
/// Error class of an opencode error text (server.mjs `classify`).
pub fn classify(text: &str) -> Class {
    for k in &texts().kinds {
        if k.re.is_match(text) { return Class { kind: k.kind.clone(), transient: k.transient, advice: k.advice.clone() }; }
    }
    Class { kind: "other".into(), transient: false, advice: String::new() }
}
