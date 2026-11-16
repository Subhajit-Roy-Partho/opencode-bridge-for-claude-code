# Errors, limits and recovery

Everything below was observed in the real opencode (v2.2.7 / v2.3.0) or is a limit of the system it runs on; each item has a test (`test/robust.test.mjs`, plus `test/live.test.mjs` for the real service).

## Where a task can fail

`opencode_status` shows `failed (<kind>)`; `opencode_result` shows `[failed: <kind>]`, the message, an `Advice:` line, and any partial output under `--- partial output ---`.

| kind | typical message | retried automatically? | what to do |
|---|---|---|---|
| `rate_limit` | `429 Too Many Requests` | yes (read-only agents) | wait; lower `OPENCODE_BRIDGE_MAX_PARALLEL`; another model |
| `overloaded` | `Overloaded`, 502/503/504/529 | yes (read-only agents) | retry later |
| `network` | `ECONNRESET`, `ETIMEDOUT`, `fetch failed` | yes (read-only agents) | check connectivity |
| `quota` | `insufficient_quota`, out of credits, billing | no | top up / switch provider; keep the work on Claude |
| `auth` | 401 / 403, invalid API key | no | `opencode auth login`, check the key |
| `context_length` | `maximum context length ...` | no | split the task, attach less, start a fresh session |
| `output_limit` | `output token limit`, stop reason length | no | ask for smaller pieces or for a file |
| `model` | `provider.no-route: Model unavailable: x` | no | fix `OPENCODE_BRIDGE_MODEL` / `model` (`opencode models`) |
| `agent` | `Agent not found: "x"` | no | install [opencode-config](https://github.com/Subhajit-Roy-Partho/opencode-config/tree/v2) or use `worker` |
| `step_limit` | `only "auto" is supported for tool_choice` | one in-session fallback (read-only agents) | see below |
| `invalid_request` | `provider.invalid-request` (other unsupported parameters) | no | another model or agent |
| `timeout` | no result within `timeout_minutes` | no | split the task or raise the limit |
| `spawn` | opencode not on `PATH`, argument list too long | no | install opencode; (large prompts are attached automatically) |
| `exit` | non-zero exit with no recognised cause | no | read the stderr line in the message |

Two outcomes are **not failures**: `interrupted` (the run was stopped before it reported an outcome: the client or the opencode service was stopped or restarted, or someone interrupted the session; recoverable, see [STATE.md](STATE.md)) and `lost` (no session exists, nothing to recover). `opencode_result` says whether a task is `recoverable`; `opencode_resume` continues it.

Classification looks only at opencode `error` events and stderr, never at the model's own text, so an answer that mentions "429" is not an error.

### The `tool_choice` failure: root cause (explorer, 2026-11-13)

14 of 14 failed `explorer` sessions in the service history ended with `provider.invalid-request: only "auto" is supported for tool_choice ... "none", "required" ... not currently supported`, every one after **exactly 15 assistant messages**; the successful explorer sessions all had fewer than 15. The `explorer` agent in `~/.config/opencode/opencode.jsonc` has `"steps": 15`: when an agent reaches its step limit, opencode makes one more request that forces a text-only answer with `tool_choice: "none"`, and the model gateway (Muse Spark) accepts only `"auto"`, so the request fails and the whole run is reported failed with all its work (25 to 62 tool calls) discarded. Agents without a `steps` limit never take that path, which is why `deep-research`, `fixer`, `librarian` and `general` mostly succeeded.

Fixes: (1) in the bridge, the error is classified `step_limit`, and a read-only agent that has a session gets **one** automatic continuation in the same session whose message asks for the final report without tools (a new turn has a fresh step counter): the task then ends `done` with `[fallback: finalize-in-session]`; verified against the real service. (2) In the opencode config, remove (or do not rely on) `"steps"` for agents that must finish a long recon; the author's own config was changed accordingly on 2026-11-13, and a running service may need `opencode reload` to pick it up. Subagent runs started by other agents through the `task` tool (for example a `fixer` that opens an `explorer`) hit the same limit and cannot be recovered by the bridge.

### Retry rules (why they are what they are)
A retry runs the whole task again in a new session. That is harmless for read-only agents (`explorer`, `librarian`, `deep-research`, `oracle`) and dangerous for agents that edit files, so: **only transient errors, only read-only agents, only when no output was produced**, at most `OPENCODE_BRIDGE_RETRIES` (default 2) times, waiting `OPENCODE_BRIDGE_RETRY_DELAY_S` (20 s) then three times that. During the wait the task is `retrying` and still counts against the parallel limit; `opencode_cancel` stops it. Everything else is reported and left to Claude (the policy says a job that fails twice is taken over by Claude).

## Limits

| Limit | Default | Setting | When hit |
|---|---|---|---|
| parallel tasks | 6 | `OPENCODE_BRIDGE_MAX_PARALLEL` (1-64) | `opencode_start` is refused and lists the running tasks |
| task wall clock | 120 min | `timeout_minutes` / `OPENCODE_BRIDGE_TIMEOUT_MIN` (1-1440) | SIGTERM to the process group, SIGKILL after `OPENCODE_BRIDGE_KILL_GRACE_MS` (5 s); status `timeout`, partial output kept |
| output kept per task | last 2 MB | | announced in `opencode_result` |
| `opencode_result` size | 60000 characters | `head` / `tail` | note says how much was omitted |
| any tool reply | 100000 characters | | middle is cut with a marker (Claude Code limits MCP tool output) |
| one command-line argument | ~128 KiB (Linux) | | prompts over ~100 KB are attached as a `0600` file and deleted afterwards; over 5 MB refused |
| any tool call | 28 s | `OPENCODE_BRIDGE_CALL_BUDGET_S` | `<tool> did not finish within the bridge's 28 s budget ...` (nothing is lost) |
| a wait (`wait_s`) | 25 s | `OPENCODE_BRIDGE_MAX_WAIT_S` (1-55) | `[still_running]` with progress and a next-poll hint |
| API call to the service | 20 s | `OPENCODE_BRIDGE_API_TIMEOUT_MS` | reads are retried once, then `timed out after ...` |
| API reply size | 64 MB | | `the reply was too large`: ask for fewer messages |
| session scan | 20 s | `OPENCODE_BRIDGE_SCAN_DEADLINE_MS` | the reply is marked `PARTIAL`, narrow the filters |
| finished tasks kept on disk | 200, 14 days | `OPENCODE_BRIDGE_KEEP_DAYS` | older ones are removed at start-up |

## Service problems (the read tools)

| Situation | Message |
|---|---|
| service not running | `the opencode background service is not reachable (is it running? ...)` (no stack trace) |
| 401 | `authentication was refused by the opencode service` |
| hung | `timed out after 20 s (the opencode service is busy or hung; retry, or restart it)` |
| opencode not installed | `the opencode binary was not found on PATH` |
| transient `ECONNRESET` | the read is repeated once, silently |

Writes (`opencode_session_rename`) are never repeated automatically.

## Timeouts of the client, restarts, cleanup
* **A tool call that blocks is a hazard** (Claude Code gives up on a long MCP call, `MCP_TOOL_TIMEOUT`). No call blocks longer than the 28 s budget; waits are bounded (`wait_s`, 25 s) and answer `[still_running]` with progress; calls that carry a progress token get MCP progress notifications; a client `notifications/cancelled` ends a wait.
* **Restarts**: every task runs detached (own process group, stdout in a file) under a runner process and is stored in the state directory ([STATE.md](STATE.md)). Closing the MCP server, restarting Claude Code, or `SIGTERM` / `SIGINT` / `SIGHUP` to the bridge leave running tasks untouched; the next bridge instance lists them and reads their status and result. `OPENCODE_BRIDGE_KILL_ON_EXIT=1` restores the old behaviour. The per-task timeout is stored as a deadline and enforced by the runner.
* **Cancel**: `opencode_cancel` interrupts the session through the service (`POST /api/session/{id}/interrupt`), stops the client's process group (SIGTERM, then SIGKILL, including the shell commands the agent started), and shows the task and the session as `cancelled`. A session id (`ses_...`) that no task owns is interrupted through the service as well.
* The temporary prompt file of a large prompt is deleted when the task ends. If the machine is rebooted or the opencode client and runner are both killed, the next snapshot reconciles the task with the service (`done`, `failed`, `interrupted` or `lost`).

## Not handled (by design)
- A task is not resumed automatically after an interruption: `opencode_resume` does it on request (editing agents only after `acknowledge_edits`).
- Work of `--standalone` runs (the `worker` agent) is lost if its client process dies: the service never owned it. Roster agents survive a dead client.
- Whether the delegated work is *correct* is not checked: see the verification rules in [POLICY.md](POLICY.md).
