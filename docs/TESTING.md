# Testing

```bash
npm test             # offline: 190 tests, ~25 s, no network, no tokens
npm run test:live    # live: 7 tests against your real opencode service
```

The same suites run against either implementation: `BRIDGE_BIN=/path/to/opencode-bridge npm test` uses the Rust binary instead of `server.mjs` (`test/texts-sync.test.mjs` checks that the texts embedded in the binary match the Node original).

## Offline suite (`test/bridge.test.mjs`, `test/policy.test.mjs`, `test/robust.test.mjs`)

Runs `server.mjs` over stdio (a real MCP client, `test/helpers.mjs`) with `test/bin/opencode` first on `PATH`. That file is a **fake opencode** with deterministic fixtures: 130 sessions across two pages (running, recent-no-active-flag, stale, active-but-old, succeeded / failed / interrupted, children, auto-named and convention-named), rich message histories (encrypted reasoning blobs, completed and running tool calls, array and object results, a 9000-character answer), title persistence for `PATCH`, and failure switches (`FAKE_FAIL`, `FAKE_NONJSON`, `FAKE_ACTIVE_FAIL`, `FAKE_EXIT`, `FAKE_SLEEP`). Every test uses a private `HOME` and clears the mode variables, so your own `~/.claude/insensitive` cannot change results.

Process tests compile `test/stub/sleeper.c` into a real binary named `opencode` (so `ps` reports the right command name and `/proc/<pid>/cmdline` holds exact arguments) and skip if no `cc` is available.

| Area | What is checked |
|---|---|
| protocol | initialize (version, echoed protocol version, `instructions`), tools/list schemas, unknown methods, notifications, bad JSON, unknown tool, quiet stderr |
| own tasks | argv of `opencode run`, titles (default, lane sanitising, clipping, explicit), continuation, cwd root check, status / result / tail / cancel / list, failure and partial output, env defaults |
| sessions | every filter, state meanings (running / stale / finished / outcomes), early stop of paging, pagination across pages, limit clamping, children, clipping, graceful `/active` failure, API failure, non-JSON, missing binary |
| output | header, chronological rendering, reasoning never shown, tool clipping, `last` / `tail` / `full`, message and size limits, empty and unknown sessions, odd ids |
| rename | request body, convention warning, trimming, empty title, unknown session, unicode |
| processes | exact titles with spaces, flags before the subcommand, TUI rows, hidden service / api / session / mcp, cwd tail, finished processes disappear |
| robustness (`robust.test.mjs`, 75 tests) | every error kind and its advice, the retry rules (read-only + transient + no output only), timeout and SIGKILL escalation, process-group kill, cancel semantics, parallel limit, oversized prompts (attachment, mode, cleanup, 5 MB limit), input validation, output caps, shutdown on stdin close / SIGTERM, service down / 401 / hung / flaky / huge replies, scan deadline, failure reasons in session output, rename sanitising, JSON-RPC edge cases, process table without /proc |
| policy | instructions content, mode detection from every source, nested working directory, precedence (sensitive wins), tier validation, agent allow-lists per mode, mechanical flag, default agents, prompt guards per agent kind, secret detection (and no false positives on ordinary text), status / list fields |

## Live suite (`test/live.test.mjs`)

Skipped unless `OPENCODE_BRIDGE_LIVE=1`. Needs a running opencode service and the `explorer` agent. It starts a real `explorer` task ("reply PONG"), waits for it, checks the process table and session list while and after it runs, reads the output (`last` and `tail`), renames the session, runs a task with a bad model (must fail as `model` with advice, no retry), sends a 120 KB prompt (must be attached as a file and really read by the agent), verifies a `hard` task is refused without creating a session, then deletes every session it created (`DELETE /api/session/{id}`).

The fake in `test/bin/opencode` reproduces the failure modes seen in the real opencode: JSON `error` events, stderr-only failures, ignored `SIGTERM`, child processes in the process group, attached files, pipes that must be drained before exit (a fake that calls `process.exit` right after a big write silently truncates it).

## Adding tests

Add a fixture case to `test/bin/opencode` if you need new service behaviour, keep fixtures generic (no real project names), and run `npm test` three times: the suite is expected to be deterministic.
