# opencode API notes (what the bridge relies on)

Tested against opencode **v2.2.7** and **v2.3.0**. The bridge never speaks HTTP itself: it runs `opencode api METHOD /path?query [-d json]`, which reaches the background service and handles authentication. (The raw HTTP endpoint answers `401` without credentials.)

| Use | Operation | Notes |
|---|---|---|
| list sessions | `GET /api/session` (`session.list`) | `limit`, `order`, `search` (title substring), `parentID`, `archived`, `directory`, `project`, `subpath`, `cursor`. Response `{ data: Session[], cursor: { previous, next } }`, newest first; follow `cursor.next`. |
| one session | `GET /api/session/{id}` (`session.get`) | `{ data: Session }` |
| messages | `GET /api/session/{id}/message` (`session.message.list`) | `limit`, `order`, `cursor`, `type`. Newest first. |
| active | `GET /api/session/active` (`session.active`) | `{ data: { <sessionId>: ... } }` for sessions the service itself is running. Runs started with `--standalone` are not in it. |
| rename | `PATCH /api/session/{id}` (`session.update`) with `{ "title": ... }` | `204`, empty body. |
| interrupt | `POST /api/session/{id}/interrupt` (`session.interrupt`) | `{"interrupted": true}` when an execution **owned by the service** was interrupted, `false` for an idle session (and for a `--standalone` run, which its own client process owns). The session then has `outcome: interrupted`; the client prints an `error` event `aborted: Session interrupted: user` and exits 1. |

Session fields used: `id`, `agent`, `title`, `outcome` (`succeeded` / `failed` / `interrupted`, absent while running), `time.created|updated`, `tokens.input|output`, `location.directory`, `parentID`.

Message shapes: `user` / `synthetic` (`text`), `assistant` (`content`: `reasoning` blocks with encrypted payloads that the bridge drops, `text`, `tool` with `state.status|input|content`), `agent-switched`, `idle` (carries `outcome`).

Documentation: <https://opencode.ai/docs/api>, `opencode api --help`, `opencode run --help` (`--title`, `--standalone`, `--agent`, `--auto`, `--format json`).

Behaviour worth knowing (v0.6):

* A run through the service (no `--standalone`) is executed **by the service**: killing the client with `SIGKILL` does not stop it, `SIGTERM` makes the client interrupt it (`outcome: interrupted`). This is why the bridge no longer kills clients when it exits and re-attaches to the session when a client dies.
* The model gateway of the Muse Spark models accepts only `tool_choice: "auto"`; opencode forces `"none"` when an agent reaches its `steps` limit, so such a run fails with `provider.invalid-request` (see ERRORS.md).
* Other routes the bridge does not use but that exist: `POST /api/session/{id}/prompt` (admit a message), `POST /api/experimental/session/{id}/wait`, `POST /api/session/{id}/fork`; the OpenAPI document is served at `/openapi.json` (`opencode api GET /openapi.json`).

Older notes: `opencode run --standalone` uses a private server but the sessions still appear in the shared store, so they can be listed and read; the service's `active` list does not know them, hence the recency rule for `running` (see the README).
