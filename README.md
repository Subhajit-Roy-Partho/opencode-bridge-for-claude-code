# opencode-bridge-for-claude-code

**Let Claude Code hand its easy and medium work to cheaper [opencode](https://opencode.ai) agents, keep the hard work for itself, and see exactly what every opencode session is doing.**

A single-file, zero-dependency [MCP](https://modelcontextprotocol.io) server (Node 18+), with an equivalent **Rust implementation** (7 ms start, 6 MB memory; see [rust/](rust/README.md)). It gives Claude Code eleven tools:

- **Delegate** a task to an opencode agent (`explorer`, `librarian`, `fixer`, `oracle`, ...) with the delegation policy *enforced by the tool*, not left to a prompt that gets forgotten.
- **Watch** every opencode session on the machine (the ones you started, the ones your subagents started, the TUI ones): which are running, which failed, what each one said and did.
- **Name** sessions consistently (`LANE/agent: task`) so a list of forty sessions is readable.

> **Companion repository: [opencode-config](https://github.com/Subhajit-Roy-Partho/opencode-config/tree/v2).** The agent roster this bridge delegates to (`explorer`, `librarian`, `deep-research`, `oracle`, `fixer`, `designer`) and the opencode-side routing rules live there. Install it as `~/.config/opencode` first. Without it only the bridge's built-in `worker` agent exists and most of what makes the delegation useful is missing.

## Why

Delegating to a cheaper model saves tokens only if it is done with discipline: send the right kind of work, never the work where a silent mistake corrupts a result, verify what comes back, and know what is running. In practice three things go wrong:

1. **The routing mode is forgotten.** A project can be "sensitive" (quality-critical: delegate only recon, docs, literature and checks) or "insensitive" (aggressive offload) or the default "blueprint" mode. Instructions in a `CLAUDE.md` get missed after a context reset. Here the mode is detected and enforced in the tool call, and it is also sent to Claude as MCP server `instructions`.
2. **Nobody can see the opencode sessions.** Subagents start `opencode run` jobs that nobody tracks. The bridge reads the opencode service's own session store.
3. **Sessions are called "Entropy-based selection of RNA structures", "New session - 2026-..." and so on.** A fixed `LANE/agent: task` title makes them sortable and searchable.

## Quick start

Requirements: Node.js >= 18, opencode **v2** with its background service (tested with 2.2.7; the bridge uses the `opencode api` command and the `/api/session` routes), the [opencode-config](https://github.com/Subhajit-Roy-Partho/opencode-config/tree/v2) agents, and a C compiler only if you want to run the process tests.

```bash
# 1. the opencode side: agent roster and routing rules. The roster is on the v2 branch (the default branch is older)
git clone -b v2 https://github.com/Subhajit-Roy-Partho/opencode-config ~/.config/opencode     # back up an existing ~/.config/opencode first

# 2. the bridge
git clone https://github.com/Subhajit-Roy-Partho/opencode-bridge-for-claude-code ~/.claude/mcp/opencode-bridge

claude mcp add --scope user opencode-bridge \
  -e OPENCODE_BRIDGE_ROOT="$HOME/projects" \
  -e OPENCODE_BRIDGE_MODEL='provider/model#variant' \
  -- node ~/.claude/mcp/opencode-bridge/server.mjs

claude mcp get opencode-bridge      # Status: ✔ Connected
```

`OPENCODE_BRIDGE_ROOT` is the only directory tree delegated tasks may work in. Restart Claude Code once; the tools appear as `mcp__opencode-bridge__opencode_*`. If you use several Claude config directories (`CLAUDE_CONFIG_DIR`), run the `claude mcp add` line once per directory with `CLAUDE_CONFIG_DIR=... claude mcp add ...`.

**Prefer the Rust binary?** Build it with `rust/build.sh` (Docker) or `cargo build --release` and register that binary instead of `node .../server.mjs`; same tools, same environment variables, same tests ([rust/README.md](rust/README.md)).

Then add a short section to your `CLAUDE.md` so Claude prefers the bridge: see [examples/claude-md-snippet.md](examples/claude-md-snippet.md).

## The tools

| Tool | Read-only | What it does |
|---|---|---|
| `opencode_start` | no | Delegate a job (async, returns a task id). Requires `tier`; enforces mode, agent allow-list, secret guard; titles the session. The run is **detached** and stored on disk: it survives a restart of the bridge or of Claude Code. Optional `wait_s` (cap 25 s) returns a quick job's outcome in the same call. |
| `opencode_status` / `opencode_result` | yes | State, elapsed time, attempts, session id, and the output of a task started by this bridge **or an earlier instance of it**. A failed task shows its **kind** (`rate_limit`, `quota`, `step_limit`, ...), the message and advice; `interrupted` and `lost` are separate outcomes with a `recoverable:` line. `wait_s` waits (at most 25 s) for the outcome and otherwise returns `[still_running]` with progress (elapsed, steps, tokens, last tool, last output age) and a next-poll hint. Output over 60000 characters is cut unless `head` / `tail` is given. |
| `opencode_cancel` | no | Cancel a running or retrying task: the session is interrupted **through the opencode service** (abort endpoint) and the client's process group gets SIGTERM, then SIGKILL; task and session then show as `cancelled`, not `interrupted`. `id` may also be a session id (`ses_...`) that no task owns. |
| `opencode_resume` | no | Continue a task that ended `interrupted` / `lost` / `failed` / `timeout` / `cancelled`: a new task with the original prompt plus the progress so far. Read-only agents resume directly; editing agents need `acknowledge_edits:true` after you looked at the `git status --short` that the reply shows. `same_session:true` continues the same opencode session. |
| `opencode_list` | yes | Persisted tasks (this bridge and earlier instances; newest 50, `limit`, `state`), with agent / tier / mode and title. |
| `opencode_policy` | yes | The active routing mode for a directory, where it was detected, the allowed agents, tier rules, verification rules, roster. |
| `opencode_sessions` | yes | **All** opencode sessions across projects: id, state, agent, age, tokens, directory, title. Filters: `state`, `agent`, `directory`, `search`, `title_prefix`, `since_minutes`, `limit`, `children`. |
| `opencode_session_output` | yes | What a session did: `mode=last` (final answer), `tail` (recent steps, default), `full`. Reasoning blocks are dropped; tool calls and results are clipped. |
| `opencode_session_rename` | writes a title | Set a session title (warns when it breaks the naming convention). |
| `opencode_processes` | yes | OS view of running `opencode run` / TUI processes with their exact `--title`, agent, cwd and elapsed time (includes runs that have no session in the service). |

Example (illustrative; `opencode_sessions state=running`):

```
2 session(s) (state=running); scanned 100; service-active ids: 0
ses_e3188e02...  running  deep-research  <1m ago  650k/29k tok  Github/project-a  ALPHA/deep-research: collect API reference notes
ses_e31688286... running  worker         <1m ago    0/0 tok     Github/project-a  BETA/worker: rename api_key to apiKey in the loader
```

Example (illustrative; `opencode_session_output mode=tail`):

```
ses_e31688286...  succeeded  worker  updated <1m ago  19k/78 tok
Github/project-a  |  BETA/worker: rename api_key to apiKey in the loader
----------------------------------------
[00:09:57] agent -> worker
[00:10:02] user: Rules: do the work yourself, ... READ-ONLY / build-and-test line ... <the task>
[00:10:04] assistant: Renaming in three files.
  -> edit({"path":"src/loader.js", ...}) [completed] => ok
[00:10:36] assistant: DONE
[00:10:37] - idle (succeeded) -
```

States: `running` (no outcome yet, and recent or reported active by the service), `succeeded`, `failed`, `interrupted` (stopped before it finished; not a provider failure), `cancelled` (interrupted on purpose through `opencode_cancel`; the service itself records it as `interrupted`) and `stale?` (no outcome but quiet for 45 minutes: crashed, killed, or a very long silent tool call). Runs of the built-in `worker` use a private `--standalone` instance and are not in the service's own `active` list, so for them `running` comes from recency.

## The delegation policy (modes and tiers)

The policy is the one in [docs/POLICY.md](docs/POLICY.md); in short:

**Tiers.** Only **easy** and **medium** work is delegated: literature search, quote extraction, DOI lookups, bulk download / parse / convert / clean, table collation, boilerplate and glue scripts, functions with a given spec, unit tests, README drafts, plots from given tables, mechanical refactors, UI against a written blueprint. **Hard and moderately hard work stays on Claude**: experiment and protocol design, split and leakage decisions, anything touching held-out data, model and feature design, statistics and every reported number, scoring / metric / energy code, non-obvious debugging, architecture, interpretation. If a silent mistake would change a result, do not delegate; if unsure, treat the job as one tier harder. `opencode_start` refuses `tier: "hard"` and `"unsure"`.

**Modes.**

| Mode | Detected from | What is allowed |
|---|---|---|
| **blueprint** (default) | nothing else set | All agents. Recon/docs first, then Claude writes a Blueprint (files, signatures, edge cases, acceptance criteria, test command) for `fixer` / `designer`; optionally `oracle` grades the diff; Claude verifies. |
| **sensitive** (conservative) | `OPENCODE_MODE` / `OPENCODE_BRIDGE_MODE` = `sensitive`; `<project>/.claude/sensitive`; the `mode` argument when the user asked | `explorer`, `librarian`, `deep-research`, `oracle`; `fixer` / `worker` only with `mechanical: true`. `designer` and `general` are refused. |
| **insensitive** (aggressive offload) | env, `<project>/.claude/insensitive`, `~/.claude/insensitive`, `$CLAUDE_CONFIG_DIR/insensitive`, or the `mode` argument | All agents; parallel lanes are encouraged. Hard work still stays on Claude. |

**Sensitive always wins** when sources disagree. The project root is the nearest parent of the working directory that has a `.claude` or `.git`. Call `opencode_policy` (optionally with `cwd`) to see the result and the reason.

**Also enforced.** Prompts that look like they contain a secret (API keys, tokens, private keys, `password=...`) are refused before anything starts. Read-only agents get an explicit read-only instruction, editing agents a "run the build/test and fix until it passes" instruction, and every run is told never to commit or push. The output is always an **untrusted draft**: Claude is told to check files exist, rerun tests, recompute numbers, inspect `git diff`.

## Session naming

`<LANE>/<agent>: <task>`: LANE in capitals (a lane or repository short name), agent = the opencode agent, task = 3-8 words. Example: `DOCS/librarian: collect API notes`. `opencode_start` sets it from `lane` (default: upper-cased directory name) and the first line of the prompt, or from an explicit `title`. For a plain `opencode run` pass `--title`; an explicit title is kept (opencode's automatic title generator backs off from custom titles). `opencode_session_rename` fixes old ones; `opencode_sessions title_prefix="DOCS/"` lists one lane. Details: [docs/SESSION-NAMING.md](docs/SESSION-NAMING.md).

## Limits, errors and recovery

The bridge assumes things go wrong and says what to do about it ([docs/ERRORS.md](docs/ERRORS.md) has the full tables, [docs/STATE.md](docs/STATE.md) the recovery design):

- **Client-side timeouts**: no tool call blocks longer than a 28 s budget; waits are bounded (`wait_s`, at most 25 s) and answer `[still_running]` with progress and the next-poll hint; a call that carries an MCP progress token gets progress notifications, and a client `notifications/cancelled` ends a wait.
- **Restarts**: every task runs **detached** under a small runner process and is registered in `~/.local/state/opencode-bridge/tasks/<id>/` (atomic JSON, outputs in files). Restarting Claude Code or the bridge does not touch running tasks; a new bridge lists them and reads their status and result, enforces the stored deadline, and reconciles tasks whose processes are gone with the opencode service (`done` / `failed` / `interrupted` / `lost`). Roster agents run through the opencode service, so even a killed client does not stop the work (the runner re-attaches to the session).
- **Interrupted sessions** (client or service stopped) are classified apart from failures; `opencode_resume` continues read-only agents directly and editing agents only after you acknowledged the working-tree state.
- **Provider errors** (rate limit, quota, context length, output limit, overload, auth, bad model or agent, network) are parsed from opencode's error events and stderr, classified, and returned with advice. Only **transient** errors of **read-only** agents that produced **no output** are retried automatically (backoff 20 s, 60 s); an agent that edits files is never replayed. The `tool_choice` error that killed long `explorer` runs (an agent's `steps` limit makes opencode force a final answer, which the gateway rejects) is classified `step_limit` and recovered once in the same session.
- **Runaway work**: at most 6 tasks at once, a 120 minute timeout per task (stored as a deadline), and cancel / timeout kill the whole process group, including the shell commands the agent started.
- **Size limits**: prompts over ~100 KB are attached as a file (Linux limits one argument to 128 KiB); replies are capped at 100000 characters; output is kept up to 2 MB per task.
- **Service problems**: a stopped, hung or unauthorised opencode service, or a huge reply, produces a one-line message, not a stack trace; long scans stop at a deadline and say `PARTIAL`.

## Configuration

| Variable | Meaning |
|---|---|
| `OPENCODE_BRIDGE_ROOT` | Directory tree delegated tasks may use as `cwd` (default: the server's working directory). |
| `OPENCODE_BRIDGE_MODEL` | Model for delegated runs, `provider/model[#variant]`. Unset = opencode's own default. |
| `OPENCODE_BRIDGE_AGENT` | Default agent when `agent` is omitted (blueprint / insensitive). Default `worker`. In sensitive mode the default is always `explorer`. |
| `OPENCODE_BRIDGE_MODE`, `OPENCODE_MODE` | Force a routing mode (`blueprint` / `sensitive` / `insensitive`). |
| `CLAUDE_CONFIG_DIR` | Also searched for an `insensitive` marker file. |
| `OPENCODE_BRIDGE_MAX_PARALLEL` | Concurrent delegated tasks, default 6 (1-64). |
| `OPENCODE_BRIDGE_TIMEOUT_MIN` | Default per-task timeout in minutes, default 120 (`timeout_minutes` overrides per task). |
| `OPENCODE_BRIDGE_RETRIES`, `OPENCODE_BRIDGE_RETRY_DELAY_S` | Automatic retries (default 2) and the first delay (default 20 s, then x3). |
| `OPENCODE_BRIDGE_API_TIMEOUT_MS`, `OPENCODE_BRIDGE_SCAN_DEADLINE_MS`, `OPENCODE_BRIDGE_KILL_GRACE_MS` | Service call timeout (20000), session-scan deadline (20000), SIGTERM to SIGKILL grace (5000). |
| `OPENCODE_BRIDGE_MAX_WAIT_S`, `OPENCODE_BRIDGE_CALL_BUDGET_S`, `OPENCODE_BRIDGE_PROGRESS_MS` | Longest `wait_s` (25, max 55), the budget no tool call may exceed (28 s), interval of MCP progress notifications (4000). |
| `OPENCODE_BRIDGE_STATE_DIR` | Task registry directory (default `$XDG_STATE_HOME/opencode-bridge`, else `~/.local/state/opencode-bridge`). |
| `OPENCODE_BRIDGE_KEEP_DAYS` | Finished task directories older than this are removed at start-up (14; the newest 200 are always the most that are kept). |
| `OPENCODE_BRIDGE_BACKEND` | `auto` (default: `worker` -> private `--standalone` instance, roster agents -> the opencode service), `service` or `standalone`. |
| `OPENCODE_BRIDGE_KILL_ON_EXIT` | `1` = cancel this instance's tasks when the bridge exits (the pre-0.6 behaviour; default: tasks keep running). |
| `OPENCODE_BRIDGE_REATTACH_POLL_MS`, `OPENCODE_BRIDGE_REATTACH_QUIET_S` | Runner: poll interval for a service session whose client died (3000), quiet time after which an inactive session without outcome counts as interrupted (90). |

## How it works

All session reads go through `opencode api GET /api/session...`, which talks to the opencode background service and handles its authentication, so the bridge never touches credentials. Routes used: `session.list`, `session.get`, `session.message.list`, `session.active`, `session.update` (title only). Delegated runs are `opencode run [--standalone] --agent <agent> --title <title> --auto --format json`, in `cwd` inside the allowed root, started by a detached runner (`server.mjs --runner <task dir>`) that keeps the task state in files ([docs/STATE.md](docs/STATE.md)). The bridge deletes no sessions; it interrupts a session (`POST /api/session/{id}/interrupt`) only when you call `opencode_cancel`. Notes on the API: [docs/API-NOTES.md](docs/API-NOTES.md).

## Tests

```bash
npm test                 # 227 offline tests: fake opencode (with a simulated service), no network, no tokens
npm run test:live        # live tests against your real opencode service (a few short jobs, cleans up after itself)
BRIDGE_BIN=/path/to/opencode-bridge npm test    # the same suite against the Rust binary
```

The offline suite covers the MCP protocol, every tool and every parameter, pagination across pages, state / stale detection, output rendering and truncation, rename, the process table (against a compiled stand-in binary named `opencode`), mode detection from every source and their precedence, tier and agent enforcement per mode, the secret guard, and every error path: provider errors and their classification, the retry rules, timeouts and process-group kills, the parallel limit, oversized prompts, service failures, and the v0.6 recovery behaviour: bounded waits and progress notifications, restarts of the bridge, killed supervisors and clients, re-attach, interrupted sessions, resume, the step-limit fallback and cancellation through the service. See [docs/TESTING.md](docs/TESTING.md).

## Limitations

- opencode **v2** only (`/api/...` routes). The older `opencode serve` HTTP API with `/session` is not supported.
- The bridge keeps no long-lived opencode server of its own: one `opencode run` process (plus a small runner) per task. A `--standalone` run (the built-in `worker`) dies with its client, so its work is lost if that process is killed; roster agents run in the opencode service and survive. A reboot ends everything that is not a service session.
- `tier` and `mode` are enforced mechanically, but whether a task is really "easy" is still Claude's judgement. The policy cannot read the task.
- Session output can contain whatever the agent saw, including file contents. The tools are read-only but the text goes to the model.

## Prior art

Other MCP servers for opencode exist, for example [nosolosoft/opencode-mcp](https://github.com/nosolosoft/opencode-mcp) and several listed on Glama. They mostly wrap the older HTTP API with basic auth. This one targets the v2 service through `opencode api`, adds the policy enforcement and the naming convention, and is designed for the [opencode-config](https://github.com/Subhajit-Roy-Partho/opencode-config/tree/v2) agent roster.

## License

[MIT](LICENSE)
