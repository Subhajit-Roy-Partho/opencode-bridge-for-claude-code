# opencode-bridge-for-claude-code

**Let Claude Code hand its easy and medium work to cheaper [opencode](https://opencode.ai) agents, keep the hard work for itself, and see exactly what every opencode session is doing.**

A single-file, zero-dependency [MCP](https://modelcontextprotocol.io) server (Node 18+). It gives Claude Code ten tools:

- **Delegate** a task to an opencode agent (`explorer`, `librarian`, `fixer`, `oracle`, ...) with the delegation policy *enforced by the tool*, not left to a prompt that gets forgotten.
- **Watch** every opencode session on the machine (the ones you started, the ones your subagents started, the TUI ones): which are running, which failed, what each one said and did.
- **Name** sessions consistently (`LANE/agent: task`) so a list of forty sessions is readable.

> **Companion repository: [opencode-config](https://github.com/Subhajit-Roy-Partho/opencode-config).** The agent roster this bridge delegates to (`explorer`, `librarian`, `deep-research`, `oracle`, `fixer`, `designer`) and the opencode-side routing rules live there. Install it as `~/.config/opencode` first. Without it only the bridge's built-in `worker` agent exists and most of what makes the delegation useful is missing.

## Why

Delegating to a cheaper model saves tokens only if it is done with discipline: send the right kind of work, never the work where a silent mistake corrupts a result, verify what comes back, and know what is running. In practice three things go wrong:

1. **The routing mode is forgotten.** A project can be "sensitive" (quality-critical: delegate only recon, docs, literature and checks) or "insensitive" (aggressive offload) or the default "blueprint" mode. Instructions in a `CLAUDE.md` get missed after a context reset. Here the mode is detected and enforced in the tool call, and it is also sent to Claude as MCP server `instructions`.
2. **Nobody can see the opencode sessions.** Subagents start `opencode run` jobs that nobody tracks. The bridge reads the opencode service's own session store.
3. **Sessions are called "Entropy-based selection of RNA structures", "New session - 2026-..." and so on.** A fixed `LANE/agent: task` title makes them sortable and searchable.

## Quick start

Requirements: Node.js >= 18, opencode **v2** with its background service (tested with 2.2.7; the bridge uses the `opencode api` command and the `/api/session` routes), the [opencode-config](https://github.com/Subhajit-Roy-Partho/opencode-config) agents, and a C compiler only if you want to run the process tests.

```bash
git clone https://github.com/Subhajit-Roy-Partho/opencode-bridge-for-claude-code ~/.claude/mcp/opencode-bridge

claude mcp add --scope user opencode-bridge \
  -e OPENCODE_BRIDGE_ROOT="$HOME/projects" \
  -e OPENCODE_BRIDGE_MODEL='provider/model#variant' \
  -- node ~/.claude/mcp/opencode-bridge/server.mjs

claude mcp get opencode-bridge      # Status: ✔ Connected
```

`OPENCODE_BRIDGE_ROOT` is the only directory tree delegated tasks may work in. Restart Claude Code once; the tools appear as `mcp__opencode-bridge__opencode_*`. If you use several Claude config directories (`CLAUDE_CONFIG_DIR`), run the `claude mcp add` line once per directory with `CLAUDE_CONFIG_DIR=... claude mcp add ...`.

Then add a short section to your `CLAUDE.md` so Claude prefers the bridge: see [examples/claude-md-snippet.md](examples/claude-md-snippet.md).

## The tools

| Tool | Read-only | What it does |
|---|---|---|
| `opencode_start` | no | Delegate a job (async, returns a task id). Requires `tier`; enforces mode, agent allow-list, secret guard; titles the session. |
| `opencode_status` / `opencode_result` | yes | State, elapsed time, attempts, session id, and the output of a task started by this bridge. A failed task shows its **kind** (`rate_limit`, `quota`, `context_length`, ...), the message and advice. Output over 60000 characters is cut unless `head` / `tail` is given. |
| `opencode_cancel` | no | Cancel a running or retrying task started by this bridge: SIGTERM then SIGKILL to its whole process group (never touches other sessions). |
| `opencode_list` | yes | Tasks started by this bridge, with agent / tier / mode and title. |
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

States: `running` (no outcome yet, and recent or reported active by the service), `succeeded`, `failed`, `interrupted`, and `stale?` (no outcome but quiet for 45 minutes: crashed, killed, or a very long silent tool call). Runs started with `--standalone` (as the bridge does) are not in the service's own `active` list, so for them `running` comes from recency.

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

The bridge assumes things go wrong and says what to do about it ([docs/ERRORS.md](docs/ERRORS.md) has the full tables):

- **Provider errors** (rate limit, quota, context length, output limit, overload, auth, bad model or agent, network) are parsed from opencode's error events and stderr, classified, and returned with advice. Only **transient** errors of **read-only** agents that produced **no output** are retried automatically (backoff 20 s, 60 s); an agent that edits files is never replayed.
- **Runaway work**: at most 6 tasks at once, a 120 minute timeout per task, and cancel / timeout / disconnect kill the whole process group, including the shell commands the agent started.
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
| `OPENCODE_BRIDGE_API_TIMEOUT_MS`, `OPENCODE_BRIDGE_SCAN_DEADLINE_MS`, `OPENCODE_BRIDGE_KILL_GRACE_MS` | Service call timeout (45000), session-scan deadline (35000), SIGTERM to SIGKILL grace (5000). |

## How it works

All session reads go through `opencode api GET /api/session...`, which talks to the opencode background service and handles its authentication, so the bridge never touches credentials. Routes used: `session.list`, `session.get`, `session.message.list`, `session.active`, `session.update` (title only). Delegated runs are `opencode run --standalone --agent <agent> --title <title> --auto --format json`, in `cwd` inside the allowed root. Nothing is ever deleted or interrupted by the bridge, and `opencode_cancel` only kills processes it started itself. Notes on the API: [docs/API-NOTES.md](docs/API-NOTES.md).

## Tests

```bash
npm test                 # 190 offline tests: fake opencode, no network, no tokens
npm run test:live        # 7 live tests against your real opencode service (spends a few thousand tokens, cleans up after itself)
```

The offline suite covers the MCP protocol, every tool and every parameter, pagination across pages, state / stale detection, output rendering and truncation, rename, the process table (against a compiled stand-in binary named `opencode`), mode detection from every source and their precedence, tier and agent enforcement per mode, the secret guard, and every error path: provider errors and their classification, the retry rules, timeouts and process-group kills, the parallel limit, oversized prompts, service failures, shutdown. See [docs/TESTING.md](docs/TESTING.md).

## Limitations

- opencode **v2** only (`/api/...` routes). The older `opencode serve` HTTP API with `/session` is not supported.
- The bridge runs one `opencode run --standalone` process per task; it does not keep a long-lived opencode server of its own. Task state is in memory: after a restart of the bridge the opencode sessions remain readable, but the tasks are no longer listed.
- `tier` and `mode` are enforced mechanically, but whether a task is really "easy" is still Claude's judgement. The policy cannot read the task.
- Session output can contain whatever the agent saw, including file contents. The tools are read-only but the text goes to the model.

## Prior art

Other MCP servers for opencode exist, for example [nosolosoft/opencode-mcp](https://github.com/nosolosoft/opencode-mcp) and several listed on Glama. They mostly wrap the older HTTP API with basic auth. This one targets the v2 service through `opencode api`, adds the policy enforcement and the naming convention, and is designed for the [opencode-config](https://github.com/Subhajit-Roy-Partho/opencode-config) agent roster.

## License

[MIT](LICENSE)
