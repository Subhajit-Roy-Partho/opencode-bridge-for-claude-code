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


### 2026-11-15 23:00 session shown as `succeeded` while the agent was still working
- Tool / command: opencode_sessions (state=all) and opencode_session_output mode=last, for a lane started with opencode_start agent=fixer tier=medium
- Error text: no error; state column showed `succeeded` ("updated 9m ago") although the agent had only paused to wait for a background `nohup` batch it had started. Its last message was "Batch is running well (866/3407 npz ...). The background waiter will notify me when the batch process exits". The OUT report did not exist yet and the underlying process (`make_design_pose.py`) was still running when checked with pgrep; the report appeared later.
- Session / task id: ses_e1d1c6157ffeKsOSnOfBr776RB (task f672b6b3), title DPGEN/fixer: batch design poses for ds1 structures
- Context: project fastDNA (cwd /home/subho/Documents/Github/fastDNA), mode blueprint (default); a long resumable batch was delegated and the agent was asked to wait for it.
- Workaround used: checked the real state with `pgrep`, the batch log and the manifest instead of trusting the session state; waited for the report file before using the result.
- Bridge version: 0.6.0
- Status: open
