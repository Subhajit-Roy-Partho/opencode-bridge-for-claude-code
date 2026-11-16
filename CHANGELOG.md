# Changelog

## 0.6.0
Robustness against client-side timeouts, restarts and interrupted sessions. Root causes, design and tests: [docs/STATE.md](docs/STATE.md), [docs/ERRORS.md](docs/ERRORS.md).
- **Restarts no longer kill work.** The old server killed every task (SIGTERM to the opencode client, which interrupts its session) when Claude Code exited or restarted: the sessions ended `interrupted` and the work was lost. Tasks now run **detached** under a runner process (`server.mjs --runner <dir>`), their stdout in a file, and are registered in `~/.local/state/opencode-bridge/tasks/<id>/` (atomic JSON; `OPENCODE_BRIDGE_STATE_DIR`). A new bridge instance lists them (`opencode_list`, marked `[earlier bridge instance]`), reads `opencode_status` / `opencode_result`, enforces the stored deadline and reconciles tasks whose processes are gone with the service (`done` / `failed` / `interrupted` / `lost`). `OPENCODE_BRIDGE_KILL_ON_EXIT=1` restores the old behaviour.
- **Roster agents run through the opencode service** (the built-in `worker` stays on a private `--standalone` instance; `OPENCODE_BRIDGE_BACKEND` overrides). The service keeps running a session when its client is killed (verified: SIGKILL of the client, session `succeeded`); the runner re-attaches to it and finishes the task from the session.
- **Bounded waits.** `opencode_status`, `opencode_result` and `opencode_start` take `wait_s` (cap 25 s, `OPENCODE_BRIDGE_MAX_WAIT_S`); a long job answers `[still_running]` with progress (elapsed, steps, tokens, last tool, last output age) and a next-poll hint. Calls that carry a progress token get MCP `notifications/progress`; `notifications/cancelled` ends a wait. Every tool call is bounded by a 28 s budget (`OPENCODE_BRIDGE_CALL_BUDGET_S`); the service call timeout and the session-scan deadline are now 20 s (were 45 s and 35 s).
- **New tool `opencode_resume`**: continues a task that ended `interrupted` / `lost` / `failed` / `timeout` / `cancelled` with the original prompt plus the progress so far; read-only agents directly, editing agents only with `acknowledge_edits:true` after the reply showed `git status --short`; `same_session:true` continues the opencode session. New outcome states `interrupted` (not a failure, with a `recoverable:` line and advice) and `lost`.
- **`tool_choice` failures (explorer)**: root cause found: the `explorer` agent has `steps: 15`; at the limit opencode forces a final answer with `tool_choice: "none"`, which the model gateway rejects (14 of 14 failed explorer sessions, each after exactly 15 assistant messages). New error kind `step_limit`; a read-only agent gets one automatic continuation in the same session that asks for the final report without tools (`[fallback: finalize-in-session]`, verified against the real service).
- **Cancellation through the service**: `opencode_cancel` calls `POST /api/session/{id}/interrupt` and stops the client's process group; task and session are listed as `cancelled`, not `interrupted` (`opencode_sessions state=cancelled`). `id` may be a session id that no bridge task owns.
- `opencode_status` flags a running task whose output has been quiet for 45 minutes (`stale?`); task directories older than 14 days are pruned at start-up.
- Tests: 227 offline (34 new in `test/recovery.test.mjs`, a simulated service in the fake opencode), live tests for restart survival, cancel through the service, the detached worker and (opt-in) the step-limit job.
- Fixed after CI: a cancelled task now frees its parallel slot at once (it counted until its runner exited); the Rust runner noticed a finished child and a cancel only every 250 ms, now within ~10 ms.
- Fixed while testing: a snapshot that raced the runner's final write could overwrite `done` with `lost`; a snapshot now reads the record again after it saw the runner exit, and reconcile never overwrites a final state.

## 0.5.0
- **Rust implementation** in `rust/` (the Node original is kept as the reference): the same ten tools and texts, the same 190 offline and 7 live tests, 7 ms start-up and 6 MB memory instead of 35 ms and 55 MB. The tool schemas, policy texts, error patterns and instructions are exported from `server.mjs` to `rust/data/texts.json` (`rust/tools/dump_texts.mjs`); `test/texts-sync.test.mjs` keeps them from drifting.
- `BRIDGE_BIN=<binary>` runs the test suites against the Rust binary; CI builds and tests both.
- `server.mjs` only starts its stdio loop when run directly, so it can be imported to read its shared constants.

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
