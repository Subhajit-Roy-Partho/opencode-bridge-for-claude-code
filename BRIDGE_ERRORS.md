# opencode bridge: error report log

Agents (Claude and opencode subagents) append every error they hit while using the opencode bridge
(`mcp__opencode-bridge__*`, `ocb.mjs`, or the `opencode` relay subagent) here, so they can be fixed.
Newest entries at the bottom. Do not put secrets, tokens or private data in an entry. Fixed entries are
marked `Status: fixed in <version/commit>`; do not delete them.

## Entry template

```
### <YYYY-MM-DD HH:MM> <short title>
- Tool / command: <e.g. opencode_start agent=explorer tier=easy>
- Error text: <exact message, short; error kind such as step_limit, rate_limit, lost>
- Session / task id: <ses_... / task id, if any>
- Context: <project (cwd), mode (blueprint/sensitive/insensitive), what was being attempted>
- Workaround used: <what was done instead, or "none">
- Bridge version: <package.json version of the installed server>
- Status: open
```

## Log

