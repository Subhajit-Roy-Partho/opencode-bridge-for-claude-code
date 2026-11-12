# Changelog

## 0.4.0
Robustness release: every failure mode that was found in the real opencode is handled, tested, and documented ([docs/ERRORS.md](docs/ERRORS.md)).
- **Provider errors**: opencode `error` events and stderr are parsed and classified (`rate_limit`, `quota`, `context_length`, `output_limit`, `overloaded`, `auth`, `model`, `agent`, `invalid_request`, `network`, `timeout`, `spawn`, `exit`) and reported by `opencode_status` / `opencode_result` with advice. Before, a bad model or agent ended as an empty "failed".
- **Automatic retry** with backoff (20 s, 60 s) only for transient errors of read-only agents that produced no output; an editing agent is never replayed.
- **Limits**: parallel-task cap (`OPENCODE_BRIDGE_MAX_PARALLEL`, 6), per-task timeout (`timeout_minutes`, 120) with SIGTERM then SIGKILL to the whole process group, output buffer cap (2 MB per task), `opencode_result` default cap 60000 characters (`head` / `tail`), 100000-character cap on every reply.
- **Large prompts**: over ~100 KB they are attached with `-f` (a single argument is limited to 128 KiB on Linux), the file is `0600` and removed afterwards; over 5 MB refused.
- **Service problems**: down service, 401, hung service (timeout), huge replies (> 64 MB) and transient read errors (one retry) give short actionable messages instead of stack traces; the session scan has a deadline and reports `PARTIAL`.
- **Session output** shows the failure kind, message and advice in the header, per-message error lines, and an output-token-limit warning.
- **Process hygiene**: tasks run in their own process group; cancel, timeout, client disconnect, `SIGTERM` / `SIGINT` / `SIGHUP` kill them and remove temp files; `opencode_cancel` on a finished task says so; finished tasks are pruned (200 kept).
- **Input validation**: empty / non-string prompt, missing `cwd`, unknown continuation id, case and spaces in `tier` / `agent` / `mode`, control characters in titles, odd JSON-RPC `arguments`.
- `opencode_processes` has a `ps` fallback without `/proc` (macOS), with a note about the approximation.
- Tests: 190 offline (was 115) and 7 live (was 5).

## 0.3.0
- Delegation policy baked into the tools: `opencode_start` requires `tier` (easy | medium; hard / unsure are refused), enforces the routing mode (blueprint | sensitive | insensitive; sensitive wins) and the per-mode agent allow-list, refuses prompts that contain secrets, and adds a read-only / build-and-test line per agent kind.
- New tool `opencode_policy` (active mode, where it was detected, allowed agents, rules). The same rules are sent as MCP server `instructions`.
- Mode detection from `OPENCODE_BRIDGE_MODE` / `OPENCODE_MODE`, `<project>/.claude/sensitive|insensitive`, `~/.claude/insensitive`, `$CLAUDE_CONFIG_DIR/insensitive`, or the `mode` argument.
- Default model is now taken only from `OPENCODE_BRIDGE_MODEL` (unset = opencode's own default).
- Roster agents are selectable (`agent`), `general` / `deep-research` keep their sub-lane permission.

## 0.2.0
- Session visibility through the opencode background service (`opencode api`): `opencode_sessions`, `opencode_session_output`, `opencode_session_rename`, `opencode_processes`.
- Session naming convention `<LANE>/<agent>: <task>`; `opencode_start` sets `--title`.

## 0.1.0
- `opencode_start` / `status` / `result` / `cancel` / `list` for tasks started by the bridge itself.
