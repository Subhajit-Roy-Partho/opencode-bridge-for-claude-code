# Errors, limits and recovery

Everything below was observed in the real opencode (v2.2.7) or is a limit of the system it runs on; each item has a test (`test/robust.test.mjs`, plus `test/live.test.mjs` for the real service).

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
| `agent` | `Agent not found: "x"` | no | install [opencode-config](https://github.com/Subhajit-Roy-Partho/opencode-config) or use `worker` |
| `invalid_request` | `provider.invalid-request` (e.g. unsupported `tool_choice`) | no | another model or agent |
| `timeout` | no result within `timeout_minutes` | no | split the task or raise the limit |
| `spawn` | opencode not on `PATH`, argument list too long | no | install opencode; (large prompts are attached automatically) |
| `exit` | non-zero exit with no recognised cause | no | read the stderr line in the message |

Classification looks only at opencode `error` events and stderr, never at the model's own text, so an answer that mentions "429" is not an error.

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
| API call to the service | 45 s | `OPENCODE_BRIDGE_API_TIMEOUT_MS` | reads are retried once, then `timed out after ...` |
| API reply size | 64 MB | | `the reply was too large`: ask for fewer messages |
| session scan | 35 s | `OPENCODE_BRIDGE_SCAN_DEADLINE_MS` | the reply is marked `PARTIAL`, narrow the filters |
| finished tasks in memory | 200 | | oldest dropped |

## Service problems (the read tools)

| Situation | Message |
|---|---|
| service not running | `the opencode background service is not reachable (is it running? ...)` (no stack trace) |
| 401 | `authentication was refused by the opencode service` |
| hung | `timed out after 45 s (the opencode service is busy or hung; retry, or restart it)` |
| opencode not installed | `the opencode binary was not found on PATH` |
| transient `ECONNRESET` | the read is repeated once, silently |

Writes (`opencode_session_rename`) are never repeated automatically.

## Processes and cleanup
Every delegated run is started in its own process group. `opencode_cancel`, a timeout, the MCP client disconnecting (stdin closed), or `SIGTERM` / `SIGINT` / `SIGHUP` kill the whole group (opencode and the shell commands it started: SIGTERM, then SIGKILL) and delete the temporary prompt file. If the bridge itself is killed with `SIGKILL`, nothing can clean up: the runs continue until they finish or hit their own limits.

## Not handled (by design)
- A task is not resumed after the bridge restarts (task state is in memory); the opencode session remains and can be read with `opencode_session_output`.
- Whether the delegated work is *correct* is not checked: see the verification rules in [POLICY.md](POLICY.md).
