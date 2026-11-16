# Task state, runner and recovery (v0.6)

How the bridge survives timeouts, restarts and interrupted sessions. This file is also the contract between the Node implementation (`server.mjs`) and the Rust one (`rust/`): both read and write the same files, so a task started by one can be read by the other.

## Why

Before 0.6 a task was a child process of the MCP server. When Claude Code exited or restarted, or one tool call timed out and the session restarted, the server received `SIGTERM` and killed every run; opencode answers `SIGTERM` by interrupting its session, so the session ended `interrupted` and the work was lost. Task state lived in memory and was gone after the restart.

Findings that shaped the design (opencode 2.3.0, tested against the real service):

| Experiment | Result |
|---|---|
| `opencode run` (through the service), client killed with `SIGKILL` | the service keeps running the session to the end (`succeeded`) |
| the same, client gets `SIGTERM` | the client interrupts the session: `interrupted` |
| `POST /api/session/{id}/interrupt` on a service session | `{"interrupted":true}`, outcome `interrupted`, the client prints an `aborted` error event and exits |
| `opencode run --standalone` (private server) | the run lives and dies with its client; the service's interrupt endpoint does not own it |

So: roster agents run through the service (a client death does not kill the work, and the work can be aborted through the API); the built-in `worker` is defined inline (`OPENCODE_CONFIG_CONTENT`), which only a private `--standalone` instance reads, so it stays standalone (`OPENCODE_BRIDGE_BACKEND=service|standalone` overrides). Both are started **detached** with their stdout in a file, so a bridge restart cannot kill them or break their pipe.

## Layout

State directory: `$OPENCODE_BRIDGE_STATE_DIR`, else `$XDG_STATE_HOME/opencode-bridge`, else `~/.local/state/opencode-bridge` (mode `0700`; every file `0600`).

```
tasks/<id>/            id = 8 hex characters
  task.json            the record (below); written atomically (tmp file + rename)
  runner.json          {pid, start}: the runner process, written by the bridge right after it spawned it
  prompt.md            the prompt as the caller gave it (used by opencode_resume)
  out.<attempt>.jsonl  stdout of `opencode run --format json` of that attempt (JSON lines, written by opencode itself)
  err.<attempt>.log    its stderr
  cancelled            marker: a cancel was requested (content: ms timestamp)
  result.txt           final answer taken from the service session (re-attach / reconcile only)
  runner.log           stdout / stderr of the runner (crash diagnostics)
cancelled/<session id> sessions the bridge interrupted on purpose: shown as `cancelled` instead of `interrupted`
```

`task.json` fields: `v`, `id`, `status`, `started`, `deadline` (= started + `timeoutMs`, the per-task timeout survives restarts), `timeoutMin`, `timeoutMs`, `mode`, `agent`, `tier`, `title`, `cwd`, `model`, `backend` (`service` | `standalone`), `head` (argv of `opencode run` up to the title), `message`, `attachDir` / `attachFile` (prompts over ~100 KB), `resumeSession`, `maxRetries`, `retryDelayMs`, `attempt`, `retryAt`, `failure` (`{kind, message, advice, transient}`), `bridge` (`{pid,start}` of the starting bridge), `child` (`{pid,start}` of the current opencode client), `sessionID`, `ended`, `exitCode`, `signal`, `reattached`, `reconciled`, `fallback` / `fallbackNote`, `resumeOf`, `mechanical`, `lane`. A process reference `{pid, start}` carries field 22 of `/proc/<pid>/stat`, so a recycled pid is not mistaken for the process; a zombie counts as dead.

## States

`running`, `retrying` (waiting for the next attempt), then one of the final states:

| status | meaning |
|---|---|
| `done` | finished, output in `out.N.jsonl` (or `result.txt`) |
| `failed` | provider / exit failure with a `kind` (see ERRORS.md) |
| `timeout` | the deadline passed; process group killed |
| `cancelled` | `opencode_cancel` (task or session); the service records the session as `interrupted`, the bridge shows `cancelled` |
| `interrupted` | the run was stopped before it reported an outcome (client or service stopped / restarted, someone interrupted the session). **Not a failure**; the work so far is in the session. Recoverable with `opencode_resume` |
| `lost` | no session exists (the run ended before opencode created one, or the session was deleted): nothing to recover, start again |

## Who writes what

* **The bridge** creates the task directory and `task.json` (status `running`), spawns the runner, writes `runner.json`. It writes `cancelled`, and after the runner is gone (see reconcile) it may write a final state.
* **The runner** (`server.mjs --runner <dir>` / `opencode-bridge --runner <dir>`; detached, its own session; one per task) owns the task while it lives: it starts `opencode run` (detached, its own process group, stdout and stderr appended to the attempt files), tails `out.N.jsonl` every 250 ms for the session id, enforces the deadline (SIGTERM, then SIGKILL after `OPENCODE_BRIDGE_KILL_GRACE_MS`) and the cancel marker, classifies the outcome, retries (read-only agents, transient errors, no output) and falls back (step limit, below), and writes the final state **before it exits**. A cancel marker always wins over any other final state.
* A snapshot (`status` / `result` / `list`) reads `task.json`, then checks the processes. If the runner is dead and the record is not final it **reads the record again** (the runner writes its final state before exiting, so a record read earlier may predate it), and only then reconciles.

## Reconcile (runner and client both gone, no final state)

1. `cancelled` marker present -> `cancelled`.
2. deadline passed -> `timeout`.
3. no session id -> `lost`.
4. ask the service (`GET /api/session/{id}`, `GET /api/session/active`; a record without outcome that is not active is read once more): active -> still `running` (only the supervisor is gone); `succeeded` -> `done` (final answer from the session messages into `result.txt`); `failed` -> `failed` (classified from the session error); `interrupted` -> `interrupted`; 404 -> `lost`; no outcome, not active, quiet for 90 s (`OPENCODE_BRIDGE_REATTACH_QUIET_S`) -> `interrupted`. If the service cannot be asked the task stays as it was (shown with a note).
5. Runner dead but client alive: shown as `running` with the note "supervisor process gone, the run continues"; the bridge kills the client when the deadline passes.

Every running bridge also does this for all dead-runner tasks at start-up and every 15 s (`supervise`).

## Re-attach (client died, service did not)

If the runner sees its client end with a signal, or a non-zero exit without an error event, and the backend is `service` and a session id is known, it does not declare a loss: it polls the service session (`OPENCODE_BRIDGE_REATTACH_POLL_MS`, 3 s) until it has an outcome, then finishes the task from that outcome (`done` with `result.txt`, `failed`, `interrupted`), flagged `reattached`. If the session cannot be found the normal failure path applies.

## Step limit (the `tool_choice` failure)

The error `only "auto" is supported for tool_choice` is classified `step_limit` (see ERRORS.md). For a read-only agent with a session id the runner starts **one** more attempt in the same session (`-s <session>`, no new title) whose message asks for the final report without tools; the task then shows `[fallback: finalize-in-session]`. Editing agents are not continued automatically.

## Bounded calls

`opencode_status`, `opencode_result` and `opencode_start` accept `wait_s` (alias `timeout_s`), capped at `OPENCODE_BRIDGE_MAX_WAIT_S` (25 s, max 55). While waiting, a call that carries `_meta.progressToken` gets `notifications/progress` every `OPENCODE_BRIDGE_PROGRESS_MS` (4 s). A client `notifications/cancelled` ends the wait. Every tool call is additionally bounded by `OPENCODE_BRIDGE_CALL_BUDGET_S` (28 s): a slow service gives an error that says nothing is lost, never a client-side timeout. A wait that expires returns `[still_running]` with progress (elapsed, steps, tokens, last tool, last output age) and the next-poll hint.

## Cancel

`opencode_cancel id=<task>`: write `cancelled`; if the backend is `service` and the client is alive, `POST /api/session/{id}/interrupt`; SIGTERM, then SIGKILL, to the client's process group; SIGTERM to the runner (it sees the marker and finalizes as `cancelled`); with a dead runner the bridge writes `cancelled` itself. `opencode_cancel id=ses_...` for a session no task owns: interrupt through the service, record `cancelled/<id>` (only when the service really had an execution to interrupt).

## Resume

`opencode_resume id=<task>` (interrupted, lost, failed, timeout, cancelled): a new task with the original prompt plus the output and last steps so far. Read-only agents resume directly; editing agents are refused until `acknowledge_edits:true`, and both the refusal and the success show `git status --short` of the working directory. `same_session:true` continues the opencode session (`-s`) with a short prompt. The delegation policy is checked again.

## Housekeeping

At start-up finished task directories older than `OPENCODE_BRIDGE_KEEP_DAYS` (14) or beyond the newest 200 are removed. `OPENCODE_BRIDGE_KILL_ON_EXIT=1` restores the pre-0.6 behaviour (cancel this instance's tasks when the bridge exits).
