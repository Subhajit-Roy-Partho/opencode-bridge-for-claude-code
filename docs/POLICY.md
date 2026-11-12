# Delegation policy

The bridge exists to make one policy hard to forget: **delegate easy and medium work to a cheaper model, keep hard work on Claude, verify everything that comes back.** This page is the reference; the tools enforce it, and the same text is sent to Claude as MCP server `instructions` and returned by `opencode_policy`.

## Tiers

`opencode_start` requires `tier`:

| tier | meaning | result |
|---|---|---|
| `easy`, `medium` | literature search and claim extraction, DOI lookups; bulk download, parse, convert, clean; table and result collation; boilerplate and glue scripts; functions with a given formula or spec; unit tests; repetitive batch launching and monitoring; README / doc drafts; plots from given tables; mechanical refactors and ports; UI against a written blueprint | accepted |
| `hard` | experiment and protocol design; data-split design and leakage checks; anything touching sealed or held-out data; model, objective and feature design; statistics and every number that is reported; scoring, metric, dataset-join, split and energy-function code; non-obvious debugging; deciding what to adopt from the literature; interpretation and synthesis; architecture; looking at images | **refused**, stays on Claude |
| `unsure` | "treat the job as one tier harder" | **refused** |

Rule of thumb: if a silent mistake would change a reported number, a conclusion, a data split, or damage data, do not delegate (or only with an independent check run by Claude). A delegated job that fails twice is taken over by Claude.

## Modes

Three modes decide *how much* is delegated. The mode is detected per working directory:

| source (checked in this order, all are collected) | gives |
|---|---|
| env `OPENCODE_BRIDGE_MODE`, env `OPENCODE_MODE` | that mode |
| `<project>/.claude/sensitive` | sensitive |
| `<project>/.claude/insensitive` | insensitive |
| `~/.claude/insensitive`, `$CLAUDE_CONFIG_DIR/insensitive` (global) | insensitive |
| `mode` argument of `opencode_start` / `opencode_policy` (use only when the user asked for a mode) | that mode |
| nothing | blueprint |

`<project>` is the nearest parent of the working directory containing `.claude` or `.git`. **Sensitive wins** over everything else (safety over speed): an explicit `insensitive` cannot lift a sensitive marker. There is deliberately no global sensitive marker file: sensitivity is a property of a project (or an explicit user request).

### blueprint (default)
Offload easy and medium work. Recon and docs first (`explorer` + `librarian`, in parallel), then Claude writes a compact **Blueprint** (target files, function signatures, edge cases, acceptance criteria, test command) and sends it to `fixer` (`designer` for UI), requiring the build / tests to pass. Optionally `oracle` grades `git diff` and the test output against the Blueprint. Claude does the final check: read the output, spot-check `git diff`, rerun the tests.

### sensitive (quality-critical projects)
Only `explorer` (recon), `librarian` (docs), `deep-research` (literature), `oracle` (checks), and `fixer` / `worker` **strictly for mechanical boilerplate or text replacement** (`mechanical: true`). `designer` and `general` are refused. All moderate and complex implementation, bugfixes and architecture stay on Claude. The default agent is `explorer`.

### insensitive (Claude as manager)
All easy and medium executable work: recon, docs and research, implementation against a blueprint, edits, installs, build/test loops, verification runs, mechanical changes. Prefer parallel lanes (`explorer` + `librarian`, one `fixer` per area). Hard work still stays on Claude unless the user says otherwise.

## Roster

| agent | use |
|---|---|
| `explorer` | read-only codebase recon, file mapping, call paths |
| `librarian` | read-only docs, library APIs, web research with ranked sources |
| `deep-research` | exhaustive literature review (needs the research tools of the opencode-config repo) |
| `oracle` | read-only independent pass/fail verification, runs tests |
| `fixer` | bounded implementation: edits, refactors, tests, build/test loop |
| `designer` | UI / UX against a written blueprint |
| `general` | mixed research + file work (may use explorer / librarian sub-lanes) |
| `worker` | built-in direct implementer of the bridge, same rules as `fixer` |

The agents are defined by [opencode-config](https://github.com/Subhajit-Roy-Partho/opencode-config/tree/v2). Read-only agents are additionally told, in the prompt, not to modify anything; editing agents are told to run the task's build/test command and fix errors; every run is told never to `git commit`/`push`/`config`.

## Verification (always)

Delegated output is an **untrusted draft**: check that files exist, rerun its tests yourself, recompute every number you report from raw outputs, inspect `git diff`, and spot-check at least 10 % of extracted literature claims (the quote is in the text, the DOI resolves). Never hand an agent secrets or credentials (the bridge refuses prompts that look like they contain one), and do not let it push, publish, delete, or touch other repositories unless the task says so.
