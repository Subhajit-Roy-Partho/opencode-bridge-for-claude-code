// OS-level view of running `opencode run` / TUI processes (exact argv from /proc, `ps` fallback elsewhere).
use crate::config::*;
use crate::util::*;
use std::process::Command;

const FLAG_WITH_VALUE: [&str; 14] = ["-m", "--model", "--agent", "--title", "-s", "--session", "-f", "--file", "--format", "--server", "--log-level", "-w", "--worktree", "--prompt"];

pub fn processes() -> Result<String, String> {
    let out = Command::new("ps").args(["-eo", "pid,etime,comm", "--no-headers"]).output().map_err(|e| e.to_string())?;
    let procfs = cfg().procfs;
    let mut rows: Vec<String> = vec![];
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = line.split_whitespace();
        let (pid, et, comm) = match (it.next(), it.next(), it.next()) { (Some(a), Some(b), Some(c)) => (a, b, c), _ => continue };
        if comm != "opencode" || !pid.chars().all(|c| c.is_ascii_digit()) { continue; }
        let (argv, approx): (Vec<String>, bool) = if procfs {
            match std::fs::read(format!("/proc/{}/cmdline", pid)) {
                Ok(b) => { let mut v: Vec<String> = b.split(|x| *x == 0).map(|s| String::from_utf8_lossy(s).to_string()).collect(); if v.last().map(|s| s.is_empty()).unwrap_or(false) { v.pop(); } (v, false) }
                Err(_) => continue,
            }
        } else {
            match Command::new("ps").args(["-o", "args=", "-p", pid]).output() { Ok(o) => (String::from_utf8_lossy(&o.stdout).trim().split(' ').map(|s| s.to_string()).collect(), true), Err(_) => continue }
        };
        if argv.is_empty() { continue; }
        let rest: Vec<&str> = argv[1..].iter().map(|s| s.as_str()).collect();
        let (mut sub, mut i) = ("", 0usize);
        while i < rest.len() {
            if FLAG_WITH_VALUE.contains(&rest[i]) { i += 2; continue; }
            if !rest[i].starts_with('-') { sub = rest[i]; break; }
            i += 1;
        }
        if !sub.is_empty() && sub != "run" { continue; }
        if rest.contains(&"--service") || rest.contains(&"--stdio") { continue; }
        let val = |f: &str| rest.iter().position(|x| *x == f).and_then(|j| rest.get(j + 1)).map(|s| s.to_string());
        let agent = val("--agent").filter(|s| !s.is_empty()).unwrap_or_else(|| "-".into());
        let mut title = val("--title").unwrap_or_default();
        if approx && !title.is_empty() {
            let j = rest.iter().position(|x| *x == "--title").unwrap();
            let stop = rest.iter().enumerate().position(|(n, x)| n > j + 1 && x.starts_with('-'));
            title = rest[j + 1..stop.unwrap_or(rest.len())].join(" ");
        }
        let message = if sub == "run" {
            let tail: Vec<&str> = rest[i + 1..].to_vec();
            tail.iter().enumerate().filter(|(j, x)| !x.starts_with('-') && !(*j > 0 && FLAG_WITH_VALUE.contains(&tail[j - 1]))).map(|(_, x)| *x).collect::<Vec<_>>().join(" ")
        } else { String::new() };
        let cwd = if procfs { std::fs::canonicalize(format!("/proc/{}/cwd", pid)).map(|p| p.to_string_lossy().to_string()).unwrap_or_default() } else { String::new() };
        let shown = if !title.is_empty() { title } else { let m = clip(&message, 80); if m.is_empty() { "(interactive)".to_string() } else { m } };
        rows.push(format!("{}  {}  {} {} {} {}", pad_start(pid, 8), pad_start(et, 10), pad_end(if sub.is_empty() { "TUI" } else { sub }, 4), pad_end(&agent, 13), pad_end(&tail_path(&cwd, 3), 34), shown));
    }
    if rows.is_empty() { return Ok("no opencode run / TUI processes".into()); }
    Ok(format!("pid        elapsed  kind agent         cwd                                title / task\n{}{}", rows.join("\n"),
        if procfs { "" } else { "\n(no /proc on this system: titles with spaces and working directories are approximate or missing)" }))
}
