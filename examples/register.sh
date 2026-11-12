#!/usr/bin/env bash
# Register the bridge for one or more Claude Code config directories.
#   ./register.sh                       # default config (~/.claude)
#   ./register.sh ~/.claude-work ...    # additional CLAUDE_CONFIG_DIR values
set -eu
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${OPENCODE_BRIDGE_ROOT:-$HOME/projects}"
add() {
  if [ -z "$1" ]; then unset CLAUDE_CONFIG_DIR; else export CLAUDE_CONFIG_DIR="$1"; fi
  claude mcp remove opencode-bridge --scope user >/dev/null 2>&1 || true
  claude mcp add --scope user opencode-bridge -e OPENCODE_BRIDGE_ROOT="$ROOT" ${OPENCODE_BRIDGE_MODEL:+-e OPENCODE_BRIDGE_MODEL="$OPENCODE_BRIDGE_MODEL"} -- node "$HERE/server.mjs"
  claude mcp get opencode-bridge | grep -E "Status|Command|Args"
}
[ "$#" -eq 0 ] && add "" || for d in "$@"; do add "$d"; done
