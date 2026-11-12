# Testing

```bash
npm test             # offline: 115 tests, ~10 s, no network, no tokens
npm run test:live    # live: 5 tests against your real opencode service
```

## Offline suite (`test/bridge.test.mjs`, `test/policy.test.mjs`)

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
| policy | instructions content, mode detection from every source, nested working directory, precedence (sensitive wins), tier validation, agent allow-lists per mode, mechanical flag, default agents, prompt guards per agent kind, secret detection (and no false positives on ordinary text), status / list fields |

## Live suite (`test/live.test.mjs`)

Skipped unless `OPENCODE_BRIDGE_LIVE=1`. Needs a running opencode service and the `explorer` agent. It starts a real `explorer` task ("reply PONG"), waits for it, checks the process table and session list while and after it runs, reads the output (`last` and `tail`), renames the session, verifies a `hard` task is refused, then deletes every session it created (`DELETE /api/session/{id}`).

## Adding tests

Add a fixture case to `test/bin/opencode` if you need new service behaviour, keep fixtures generic (no real project names), and run `npm test` three times: the suite is expected to be deterministic.
