# Changelog

## 0.3.0
- Delegation policy baked into the tools: `opencode_start` requires `tier` (easy | medium; hard / unsure are refused), enforces the routing mode (blueprint | sensitive | insensitive; sensitive wins) and the per-mode agent allow-list, refuses prompts that contain secrets, and adds a read-only / build-and-test line per agent kind.
- New tool `opencode_policy` (active mode, where it was detected, allowed agents, rules). The same rules are sent as MCP server `instructions`.
- Mode detection from `OPENCODE_BRIDGE_MODE` / `OPENCODE_MODE`, `<project>/.claude/sensitive|insensitive`, `~/.claude/insensitive`, `$CLAUDE_CONFIG_DIR/insensitive`, or the `mode` argument.
- Default model is now taken only from `OPENCODE_BRIDGE_MODEL` (unset = opencode's own default).
- Roster agents are selectable (`agent`), `general` / `deep-research` keep their sub-lane permission.

## 0.2.0
- Session visibility through the opencode background service (`opencode api`): `opencode_sessions`, `opencode_session_output`, `opencode_session_rename`, `opencode_processes`.
- Session naming convention `<LANE>/<agent>: <task>`; `opencode_start` sets `--title`.

## 0.1.0
- `opencode_start` / `status` / `result` / `cancel` / `list` for tasks started by the bridge itself.
