# Session naming

```
<LANE>/<agent>: <task>
```

| part | rule | examples |
|---|---|---|
| `LANE` | capitals, `[A-Z0-9._-]`; the lane or repository short name | `DOCS`, `API-MIGRATION`, `PROJECT-A` |
| `agent` | the opencode agent, lower case | `explorer`, `librarian`, `deep-research`, `oracle`, `fixer`, `designer`, `general`, `worker` |
| `task` | 3-8 words, what the session is for | `collect API reference notes` |

Good: `DOCS/librarian: collect API reference notes`, `API-MIGRATION/fixer: port loader to v2`.
Not good: `New session - 2026-11-12T...`, `fix stuff`, `Entropy-based selection of RNA structures` (no lane, no agent; unsortable).

## How titles get set

- `opencode_start` builds `LANE/agent: first line of the prompt` (clipped to 60 characters) from `lane` (default: the upper-cased name of the working directory) or uses `title` verbatim. A continued session (`session` argument) keeps its title.
- A plain `opencode run`: `opencode run --title "DOCS/librarian: collect API notes" --agent librarian ...`. An explicit title is kept; opencode's automatic title generation only applies when none is given.
- Repair existing sessions with `opencode_session_rename`; it accepts any non-empty title and adds a warning when the title does not match the convention.

## Why this shape

- `title_prefix="DOCS/"` (or `search`) lists one lane; `agent="fixer"` lists one role; the two combine.
- The title is shown in `opencode_sessions`, in `opencode_processes` (taken from the exact `--title` argument of the running process) and in `opencode_session_output`, so the same name follows a job from start to finish.
- The agent is in the title because the opencode UI and logs otherwise hide which lane a session ran in.
