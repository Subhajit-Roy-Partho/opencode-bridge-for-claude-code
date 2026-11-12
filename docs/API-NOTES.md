# opencode API notes (what the bridge relies on)

Tested against opencode **v2.2.7**. The bridge never speaks HTTP itself: it runs `opencode api METHOD /path?query [-d json]`, which reaches the background service and handles authentication. (The raw HTTP endpoint answers `401` without credentials.)

| Use | Operation | Notes |
|---|---|---|
| list sessions | `GET /api/session` (`session.list`) | `limit`, `order`, `search` (title substring), `parentID`, `archived`, `directory`, `project`, `subpath`, `cursor`. Response `{ data: Session[], cursor: { previous, next } }`, newest first; follow `cursor.next`. |
| one session | `GET /api/session/{id}` (`session.get`) | `{ data: Session }` |
| messages | `GET /api/session/{id}/message` (`session.message.list`) | `limit`, `order`, `cursor`, `type`. Newest first. |
| active | `GET /api/session/active` (`session.active`) | `{ data: { <sessionId>: ... } }` for sessions the service itself is running. Runs started with `--standalone` are not in it. |
| rename | `PATCH /api/session/{id}` (`session.update`) with `{ "title": ... }` | `204`, empty body. |

Session fields used: `id`, `agent`, `title`, `outcome` (`succeeded` / `failed` / `interrupted`, absent while running), `time.created|updated`, `tokens.input|output`, `location.directory`, `parentID`.

Message shapes: `user` / `synthetic` (`text`), `assistant` (`content`: `reasoning` blocks with encrypted payloads that the bridge drops, `text`, `tool` with `state.status|input|content`), `agent-switched`, `idle` (carries `outcome`).

Documentation: <https://opencode.ai/docs/api>, `opencode api --help`, `opencode run --help` (`--title`, `--standalone`, `--agent`, `--auto`, `--format json`).

Behaviour worth knowing: `opencode run --standalone` uses a private server but the sessions still appear in the shared store, so they can be listed and read; the service's `active` list does not know them, hence the recency rule for `running` (see the README).
