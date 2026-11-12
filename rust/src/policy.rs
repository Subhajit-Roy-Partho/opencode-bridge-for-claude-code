// Delegation policy: routing-mode detection, tier / agent enforcement, the `opencode_policy` text.
use crate::config::*;
use crate::util::*;
use serde_json::Value;
use std::path::Path;

pub const MODES: [&str; 3] = ["blueprint", "sensitive", "insensitive"];

pub struct ModeDet { pub mode: String, pub source: String, pub all: Vec<(String, String)> }

fn project_root(cwd: &str) -> String {
    let mut d = cwd.to_string();
    loop {
        if Path::new(&format!("{}/.claude", d)).exists() || Path::new(&format!("{}/.git", d)).exists() { return d; }
        let up = match Path::new(&d).parent() { Some(p) => p.to_string_lossy().to_string(), None => return cwd.to_string() };
        let up = if up.is_empty() { "/".to_string() } else { up };
        if up == d { return cwd.to_string(); }
        d = up;
    }
}

/// Sources: env OPENCODE_BRIDGE_MODE / OPENCODE_MODE, <project>/.claude/{sensitive,insensitive}, ~/.claude/insensitive and
/// $CLAUDE_CONFIG_DIR/insensitive, an explicit `mode` argument. SENSITIVE wins, then INSENSITIVE, else BLUEPRINT.
pub fn detect_mode(cwd: &str, explicit: Option<&str>) -> Result<ModeDet, String> {
    let mut found: Vec<(String, String)> = vec![];
    let mut add = |m: &str, src: String| { if MODES.contains(&m) { found.push((m.to_string(), src)); } };
    let home = std::env::var("HOME").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/root".into());
    let root = project_root(cwd);
    add(&std::env::var("OPENCODE_BRIDGE_MODE").unwrap_or_default().to_lowercase(), "env OPENCODE_BRIDGE_MODE".into());
    add(&std::env::var("OPENCODE_MODE").unwrap_or_default().to_lowercase(), "env OPENCODE_MODE".into());
    if Path::new(&format!("{}/.claude/sensitive", root)).exists() { add("sensitive", format!("{}/.claude/sensitive", root)); }
    if Path::new(&format!("{}/.claude/insensitive", root)).exists() { add("insensitive", format!("{}/.claude/insensitive", root)); }
    let mut dirs = vec![format!("{}/.claude", home)];
    if let Ok(c) = std::env::var("CLAUDE_CONFIG_DIR") { if !c.is_empty() && !dirs.contains(&c) { dirs.push(c); } }
    for d in dirs { if Path::new(&format!("{}/insensitive", d)).exists() { add("insensitive", format!("{}/insensitive", d)); } }
    if let Some(e) = explicit.filter(|e| !e.is_empty()) {
        let m = e.to_lowercase();
        if !MODES.contains(&m.as_str()) { return Err(format!("mode must be one of {}", MODES.join(" | "))); }
        add(&m, "mode argument (user request)".into());
    }
    let pick = found.iter().find(|f| f.0 == "sensitive").or_else(|| found.iter().find(|f| f.0 == "insensitive")).cloned().unwrap_or(("blueprint".into(), "default".into()));
    Ok(ModeDet { mode: pick.0, source: pick.1, all: found })
}

pub fn check_delegation(agent: &str, tier: Option<&str>, mechanical: bool, prompt: &str, mode: &str) -> Result<(), String> {
    let tier_rule = txt("tierRule");
    let tier = match tier.filter(|t| !t.is_empty()) {
        None => return Err(format!("tier is required: \"easy\" or \"medium\" (delegable) - or \"hard\"/\"unsure\" (stay on Claude). {}", tier_rule)),
        Some(t) => t,
    };
    if !["easy", "medium", "hard", "unsure"].contains(&tier) { return Err("tier must be easy | medium | hard | unsure".into()); }
    if tier == "hard" || tier == "unsure" {
        return Err(format!("refused by delegation policy: tier \"{}\" stays on Claude (unsure = one tier harder). {}", tier, tier_rule));
    }
    if !roster_has(agent) {
        return Err(format!("unknown agent \"{}\"; roster: {}", agent, texts().roster.iter().map(|r| r.0.clone()).collect::<Vec<_>>().join(", ")));
    }
    if mode == "sensitive" {
        if agent == "designer" || agent == "general" {
            return Err(format!("SENSITIVE mode: agent \"{}\" is not delegated (allowed: explorer, librarian, deep-research, oracle, and fixer/worker only for mechanical work).", agent));
        }
        if is_editor(agent) && !mechanical {
            return Err(format!("SENSITIVE mode: \"{}\" may only do strictly mechanical boilerplate / text replacement - pass mechanical:true if that is what this is, otherwise keep the work on Claude.", agent));
        }
    }
    for (re, src) in &texts().secrets {
        if re.is_match(prompt) {
            return Err(format!("refused: the prompt looks like it contains a secret or credential (pattern {}...). Never hand secrets to opencode; pass a path or an env var name instead.", first_chars(src, 30)));
        }
    }
    Ok(())
}

pub fn agent_rule(agent: &str) -> &'static str { if is_read_only(agent) { txt("agentRuleReadOnly") } else { txt("agentRuleEdit") } }
pub fn guard_for(agent: &str) -> &'static str { if agent == "general" || agent == "deep-research" { txt("guardLanes") } else { txt("guard") } }

/// `cwd` must exist and be inside the allowed root; returns its real path.
pub fn resolve_cwd(cwd: &str) -> Result<String, String> {
    let real = std::fs::canonicalize(cwd).map_err(|_| format!("cwd does not exist: {}", cwd))?.to_string_lossy().to_string();
    let root = &cfg().root;
    if real == *root || real.starts_with(&format!("{}/", root)) { Ok(real) } else { Err(format!("cwd must be inside {}", root)) }
}

pub fn policy_text(args: &Value) -> Result<String, String> {
    let c = cfg();
    let cwd_arg = arg_str(args, "cwd").unwrap_or_else(|| c.root.clone());
    let real = match std::fs::canonicalize(&cwd_arg) {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => return Err(format!("ENOENT: no such file or directory, realpath '{}' ({})", cwd_arg, e)),
    };
    if !(real == c.root || real.starts_with(&format!("{}/", c.root))) { return Err(format!("cwd must be inside {}", c.root)); }
    let det = detect_mode(&real, arg_str(args, "mode").as_deref())?;
    let allowed: Vec<String> = if det.mode == "sensitive" {
        ["explorer", "librarian", "deep-research", "oracle", "fixer (mechanical:true only)", "worker (mechanical:true only)"].iter().map(|s| s.to_string()).collect()
    } else { texts().roster.iter().map(|r| r.0.clone()).collect() };
    let also = if det.all.len() > 1 { format!("; also seen: {}", det.all.iter().map(|f| format!("{} via {}", f.0, f.1)).collect::<Vec<_>>().join(", ")) } else { String::new() };
    let roster = texts().roster.iter().map(|(k, v)| format!("  {} {}", pad_end(k, 14), v)).collect::<Vec<_>>().join("\n");
    let lines = vec![
        format!("ACTIVE MODE: {}  (source: {}{})", det.mode.to_uppercase(), det.source, also),
        format!("directory evaluated: {}", real), String::new(),
        texts().raw["modeRules"][&det.mode].as_str().unwrap_or("").to_string(), String::new(),
        format!("Agents allowed here: {}", allowed.join(", ")), String::new(),
        format!("TIERS: {}", txt("tierRule")), String::new(), format!("VERIFY: {}", txt("verifyRule")), String::new(),
        format!("ROSTER:\n{}", roster), String::new(),
        format!("LIMITS: {} parallel tasks, timeout {} min, {} automatic retries (read-only agents, transient errors only), tool output capped at {} characters. Error kinds and advice: see opencode_result.", c.max_parallel, c.default_timeout_min, c.max_retries, RESPONSE_CAP), String::new(),
        "Detection order (SENSITIVE wins): env OPENCODE_BRIDGE_MODE / OPENCODE_MODE; <project>/.claude/sensitive; <project>/.claude/insensitive; ~/.claude/insensitive and $CLAUDE_CONFIG_DIR/insensitive; the `mode` argument when the user asked. Default: blueprint.".to_string(),
        "Roster agents are defined in https://github.com/Subhajit-Roy-Partho/opencode-config/tree/v2 (install it as ~/.config/opencode). Policy text: \"OpenCode Specialist Delegation\" in CLAUDE.md.".to_string(),
    ];
    Ok(lines.join("\n"))
}
