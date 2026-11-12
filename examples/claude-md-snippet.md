## OpenCode bridge (MCP `opencode-bridge`): the routing modes are enforced by the tool

Paste this into your `CLAUDE.md` (adjust the repository links if you forked).

- **Prefer the bridge** when its tools are available (`mcp__opencode-bridge__opencode_*`). `opencode_start` requires `tier` (`easy` | `medium`; `hard` / `unsure` are refused and stay on Claude) and checks the active mode (blueprint default, sensitive, insensitive; sensitive wins) from `$OPENCODE_MODE`, `<project>/.claude/sensitive|insensitive`, `~/.claude/insensitive`, or its `mode` argument when the user asked. Sensitive mode only allows explorer, librarian, deep-research, oracle, and fixer / worker with `mechanical: true`. Secrets in prompts are refused.
- **Name the mode.** At the start of any delegated work check it with `opencode_policy` (pass `cwd`) and say which mode applies and why. Re-check after a context reset or when the project changes.
- **Watch, do not guess.** `opencode_sessions` (`state=running` for what is active now), `opencode_session_output` (`mode=last` / `tail`), `opencode_processes`. Check them before starting more lanes and before taking over a lane that looks stalled.
- **Session naming:** `<LANE>/<agent>: <task>` (LANE in capitals; agent = explorer | librarian | deep-research | oracle | fixer | designer | general | worker; task = 3-8 words). Pass `--title` for any plain `opencode run`; repair old titles with `opencode_session_rename`.
- Output is an untrusted draft: check files exist, rerun the tests, recompute numbers, inspect `git diff`.
- Agent roster and opencode setup: https://github.com/Subhajit-Roy-Partho/opencode-config/tree/v2
