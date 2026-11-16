#!/usr/bin/env node
// Minimal stdio MCP server between Claude Code (master) and opencode. No dependencies.
//
// Part 1 - own tasks (v0.1): opencode_start (async), opencode_status, opencode_result, opencode_cancel, opencode_list.
// Part 3 - delegation policy (v0.3): opencode_policy, plus enforcement inside opencode_start (tier, routing mode, agent allow-list,
//          secret guard) and the same rules in the server `instructions` that Claude Code injects into the system prompt.
// Part 2 - session visibility (v0.2, READ-ONLY apart from renaming a title): opencode_sessions, opencode_session_output,
//          opencode_session_rename, opencode_processes. They read every session known to the opencode background service
//          (those started by this bridge, by `opencode run` in subagents, by the TUI, ...) through the service's own
//          authenticated HTTP API, reached with `opencode api` (v2 routes under /api; see docs below).
//
// Session naming convention (see ~/.claude/CLAUDE.md):  "<LANE>/<agent>: <task>"
//   LANE  = lane or project short name in capitals (ALPHA, DOCS-SYNC, BUILD-TESTS, or the repository name);
//   agent = opencode agent (deep-research, explorer, librarian, oracle, fixer, designer, general, worker);
//   task  = 3-8 words. Example: "ALPHA/deep-research: collect API reference notes".
//
// opencode docs used: https://opencode.ai/docs/api (operation IDs session.list, session.get, session.message.list,
// session.update, session.active), `opencode run --help` (--title), `opencode api --help`.
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { realpathSync, readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, renameSync, openSync, closeSync, readSync, fstatSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.6.0';
// Model for delegated runs (provider/model[#variant]). Unset = no -m flag, i.e. opencode's own default model.
const DEFAULT_MODEL = process.env.OPENCODE_BRIDGE_MODEL || '';
// Workers may only operate inside this root (set per-registration).
const ROOT = realpathSync(process.env.OPENCODE_BRIDGE_ROOT || process.cwd());
// A plain agent that never delegates (the default 'orchestrator' hands work to sub-agents and may end its turn before they return).
// It is defined inline and run on a private (--standalone) opencode instance so the user's global config is untouched.
const WORKER_CONFIG = JSON.stringify({ agent: { worker: { mode: 'primary',
  description: 'Direct implementer: does the work itself, never delegates',
  prompt: 'You are a direct implementer. Do all work yourself with your own file and shell tools. Never launch sub-agents or tasks. Do not end your turn until the work is finished and verified.',
  permission: { task: 'deny' } } } });
const GUARD_TAIL = 'work only inside the current directory; never run git commit/push/config; never touch files outside your assigned paths; finish with a short summary of files created/changed.';
const GUARD = 'Rules: do the work yourself, never delegate to other agents, do not stop until finished; ' + GUARD_TAIL;
const GUARD_LANES = 'Rules: you may use your own explorer/librarian sub-lanes for missing context (one level, never deeper), do not stop until finished; ' + GUARD_TAIL; // general / deep-research
const guardFor = (agent) => (['general', 'deep-research'].includes(agent) ? GUARD_LANES : GUARD);
const STALE_MIN = 45; // a session with no outcome and no update for this long is reported as "stale?" (crashed / killed / hung)

// ---------- limits and robustness (v0.4) ----------
const num = (v, d, lo, hi) => { if (v === undefined || v === null || v === '') return d; const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };
const MAX_PARALLEL = num(process.env.OPENCODE_BRIDGE_MAX_PARALLEL, 6, 1, 64);            // concurrent delegated tasks
const DEFAULT_TIMEOUT_MIN = num(process.env.OPENCODE_BRIDGE_TIMEOUT_MIN, 120, 1, 1440);  // per-task wall clock
const MAX_RETRIES = num(process.env.OPENCODE_BRIDGE_RETRIES, 2, 0, 5);                   // automatic retries: read-only agents, transient errors only
const RETRY_DELAY_MS = num(process.env.OPENCODE_BRIDGE_RETRY_DELAY_S, 20, 0, 600) * 1000; // first delay; x3 for the next
const API_TIMEOUT_MS = num(process.env.OPENCODE_BRIDGE_API_TIMEOUT_MS, 20000, 200, 600000);
const SCAN_DEADLINE_MS = num(process.env.OPENCODE_BRIDGE_SCAN_DEADLINE_MS, 20000, 200, 600000);
const KILL_GRACE_MS = num(process.env.OPENCODE_BRIDGE_KILL_GRACE_MS, 5000, 50, 60000);   // SIGTERM -> SIGKILL
const MAX_TEXT = 2_000_000;      // output kept per task (the last 2 MB)
const ARG_LIMIT = 100_000;       // bytes; Linux allows ~128 KiB per single argument, larger prompts are attached as a file
const PROMPT_MAX = 5_000_000;
const RESULT_CAP = 60_000;       // default size of opencode_result (Claude Code limits MCP tool output)
const RESPONSE_CAP = 100_000;    // hard cap of any tool reply
const PROCFS = process.env.OPENCODE_BRIDGE_PROCFS !== '0' && existsSync('/proc/self/cmdline'); // OPENCODE_BRIDGE_PROCFS=0 forces the ps fallback (tests)
const TIMEOUT_UNIT_MS = num(process.env.OPENCODE_BRIDGE_TIMEOUT_UNIT_MS, 60000, 10, 60000); // one "minute" of timeout_minutes (tests shorten it)
const KEEP_FINISHED = 200;       // finished tasks kept on disk (older ones are pruned at start-up)
// v0.6: persistence, bounded waits, re-attach
const STATE_DIR = process.env.OPENCODE_BRIDGE_STATE_DIR || join(process.env.XDG_STATE_HOME || join(process.env.HOME || homedir(), '.local', 'state'), 'opencode-bridge'); // task registry, see docs/STATE.md
const KEEP_DAYS = num(process.env.OPENCODE_BRIDGE_KEEP_DAYS, 14, 1, 365);                  // finished task directories older than this are pruned
const MAX_WAIT_S = num(process.env.OPENCODE_BRIDGE_MAX_WAIT_S, 25, 1, 55);               // longest wait of opencode_status / opencode_result / opencode_start (wait_s)
const CALL_BUDGET_MS = num(process.env.OPENCODE_BRIDGE_CALL_BUDGET_S, 28, 0.2, 120) * 1000; // no tool call blocks longer than this
const PROGRESS_MS = num(process.env.OPENCODE_BRIDGE_PROGRESS_MS, 4000, 50, 60000);        // MCP progress notification interval for calls that pass a progressToken
const WAIT_POLL_MS = num(process.env.OPENCODE_BRIDGE_WAIT_POLL_MS, 300, 10, 5000);
const REATTACH_POLL_MS = num(process.env.OPENCODE_BRIDGE_REATTACH_POLL_MS, 3000, 20, 60000); // runner: polling of a service session whose client died
const REATTACH_QUIET_MS = num(process.env.OPENCODE_BRIDGE_REATTACH_QUIET_S, 90, 0.05, 3600) * 1000; // a session the service does not run and that was quiet this long is "interrupted"
const BACKEND = ['auto', 'service', 'standalone'].includes(process.env.OPENCODE_BRIDGE_BACKEND) ? process.env.OPENCODE_BRIDGE_BACKEND : 'auto'; // auto: worker -> private instance, roster agents -> the service
const KILL_ON_EXIT = process.env.OPENCODE_BRIDGE_KILL_ON_EXIT === '1';                     // legacy: cancel this instance's tasks when the bridge exits
const SELF = fileURLToPath(import.meta.url);
const RUNNER_CMD = [process.execPath, SELF];

// Error classes: [kind, transient (worth retrying), pattern, advice]. Applied to opencode error events / stderr, never to model text.
const KINDS = [
  ['quota', false, /insufficient[_ ]?(quota|funds|credits?|balance)|quota (exceeded|exhausted)|exceeded your (current )?(quota|plan)|out of credits?|billing|usage limit|payment required|\b402\b/i, 'Account quota or credits are exhausted. Not retried. Top up, wait for the reset, or switch model/provider; keep the work on Claude meanwhile.'],
  ['output_limit', false, /output[ _-]?(token )?limit|stop reason: length|finish.?reason.{0,3}length|max(imum)? output tokens/i, 'The agent hit its output-token limit. Ask for smaller pieces, or have it write the result to a file and report the path.'],
  ['context_length', false, /context[ _-]?(length|window)|maximum context|prompt is too long|too many tokens|input is too long|exceeds? (the )?(model'?s )?(maximum|max|limit)[^.]{0,40}tokens?|token limit/i, "The prompt or session is too large for the model's context. Split the task, attach less, and start a fresh session (do not continue this one)."],
  ['rate_limit', true, /\b429\b|rate[ _-]?limit|too many requests|requests? per (minute|second)|throttl/i, 'Provider rate limit. Read-only agents are retried automatically with backoff; otherwise wait and retry, lower OPENCODE_BRIDGE_MAX_PARALLEL, or use another model.'],
  ['overloaded', true, /overloaded|\b(502|503|504|529)\b|capacity|temporarily unavailable|service unavailable|bad gateway|gateway time-?out/i, 'The provider is overloaded or unavailable (transient). Read-only agents are retried automatically; otherwise retry later.'],
  ['auth', false, /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[ _-]?api[ _-]?key|authentication|not logged in|credentials? (expired|invalid)/i, 'Authentication problem. Not retried. Check the provider login or key (`opencode auth login`).'],
  ['agent', false, /agent not found/i, 'Agent not found. Install the roster from the opencode-config repository, or use agent "worker".'],
  ['model', false, /provider\.no-route|model (is )?(unavailable|not found)|unknown model|no such model/i, 'Model unavailable. Check OPENCODE_BRIDGE_MODEL / the `model` argument (`opencode models` lists valid ids).'],
  ['step_limit', false, /tool_choice/i, 'The provider rejected a forced `tool_choice`. This is what happens when an agent reaches its `steps` limit: opencode then forces a final answer, and a provider that only accepts "auto" fails the request (docs/ERRORS.md). Read-only agents are asked automatically, once, to write their report in the same session; otherwise use opencode_resume, or remove / raise `steps` of that agent in opencode.jsonc.'],
  ['invalid_request', false, /provider\.invalid-request|invalid[ _-]request|bad request|\b400\b/i, 'The provider rejected the request (often an agent or tool setting the model does not support). Not retried; try another model or agent.'],
  ['network', true, /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|socket hang up|fetch failed|network|connection (reset|closed|refused|error)|timed? ?out/i, 'Network problem talking to the provider (transient). Read-only agents are retried automatically; otherwise check connectivity and retry.'],
];
function classify(text) { const t = String(text ?? ''); for (const [kind, transient, re, advice] of KINDS) if (re.test(t)) return { kind, transient, advice }; return { kind: 'other', transient: false, advice: '' }; }
const errText = (e) => (e == null ? '' : typeof e === 'string' ? e : [e.type, e.message ?? e.name ?? JSON.stringify(e)].filter(Boolean).join(': '));


// ---------- delegation policy (routing modes baked in) ----------
// Mirrors the "OpenCode Specialist Delegation" section of CLAUDE.md so the rules travel with the tool, not only with a prompt file.
//   Modes:  blueprint (default) | sensitive | insensitive.  SENSITIVE WINS on any conflict.
//   Tiers:  easy / medium are delegated; hard / moderately hard (and "unsure" = one tier harder) stay on Claude.
const MODES = ['blueprint', 'sensitive', 'insensitive'];
const READ_ONLY = new Set(['explorer', 'librarian', 'deep-research', 'oracle']);
const EDITORS = new Set(['fixer', 'designer', 'worker']);
const ROSTER = {
  explorer: 'read-only codebase recon: file mapping, call paths, how it works',
  librarian: 'read-only docs / library API / web research with ranked sources',
  'deep-research': 'exhaustive literature review (needs the opencode-config research tools; run only when literature work is requested)',
  oracle: 'read-only independent pass/fail verification against criteria, runs tests',
  fixer: 'bounded implementation against a written blueprint: edits, refactors, tests, build/test loop',
  designer: 'UI / UX views, layouts, copy against a written blueprint',
  general: 'mixed research + file work that needs both explorer and librarian lanes',
  worker: "the bridge's built-in direct implementer (does the work itself, never delegates); same rules as fixer",
};
const MODE_RULES = {
  blueprint: 'BLUEPRINT (default): offload easy + medium work. Recon/docs first (explorer + librarian in parallel), then write a compact Blueprint (target files, signatures, edge cases, acceptance criteria, test command), send it to fixer (designer for UI), optionally have oracle grade git diff + tests, then verify yourself (read output, spot-check git diff, rerun the tests).',
  sensitive: 'SENSITIVE (conservative, quality-critical): delegate ONLY explorer, librarian, deep-research, oracle, and fixer strictly for mechanical boilerplate / text replacement (pass mechanical:true). All moderate and complex implementation, bugfixes and architecture stay on Claude.',
  insensitive: 'INSENSITIVE (aggressive offload, Claude is manager): delegate all easy + medium executable work - recon, docs/research, implementation against a blueprint, edits, installs, build/test loops, verification runs, mechanical changes; prefer parallel lanes (explorer + librarian, per-area fixer lanes). Hard / moderately hard still stay on Claude.',
};
const TIER_RULE = 'Delegate EASY and MEDIUM only (literature search, quote extraction, DOI lookups, bulk download/parse/convert/clean, table collation, boilerplate and glue scripts, functions with a given formula, unit tests, README drafts, plots from given tables, mechanical refactors, UI against a written blueprint). Keep HARD and MODERATELY HARD on Claude: experiment / protocol design, split and leakage decisions, anything touching sealed or held-out data, model/objective/feature design, statistics and every reported number, scoring / metric / dataset-join / split / energy-function code, non-obvious debugging, architecture, interpretation. Rule of thumb: if a silent mistake would change a reported number, a conclusion, a data split, or damage data, do not delegate. If unsure, treat the job as one tier harder (tier "unsure" is refused).';
const VERIFY_RULE = 'Treat the output as an untrusted draft: check files exist, rerun the tests yourself, recompute every reported number from raw outputs, inspect git diff, spot-check >=10% of literature claims (quote in the text, DOI resolves). Never hand it secrets or credentials; do not let it push, publish, delete, or touch other repositories unless the task says so. A delegated job that fails twice is taken over by Claude.';
const SECRET_RES = [/\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, /\b(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9/+_.-]{16,}/i];

function projectRoot(cwd) { // nearest ancestor with a .claude directory or a .git entry; falls back to cwd
  let d = cwd;
  for (;;) { if (existsSync(`${d}/.claude`) || existsSync(`${d}/.git`)) return d; const up = d.replace(/\/[^/]*$/, '') || '/'; if (up === d) return cwd; d = up; }
}
// Sources (same as CLAUDE.md): env OPENCODE_BRIDGE_MODE / OPENCODE_MODE, <project>/.claude/{sensitive,insensitive},
// ~/.claude/insensitive and $CLAUDE_CONFIG_DIR/insensitive (global), and an explicit `mode` argument (= the user asked).
// SENSITIVE wins over everything; otherwise INSENSITIVE; otherwise BLUEPRINT.
function detectMode(cwd, explicit) {
  const found = [], home = process.env.HOME || homedir(), root = projectRoot(cwd);
  const add = (m, src) => { if (MODES.includes(m)) found.push({ mode: m, src }); };
  add(String(process.env.OPENCODE_BRIDGE_MODE || '').toLowerCase(), 'env OPENCODE_BRIDGE_MODE');
  add(String(process.env.OPENCODE_MODE || '').toLowerCase(), 'env OPENCODE_MODE');
  if (existsSync(`${root}/.claude/sensitive`)) add('sensitive', `${root}/.claude/sensitive`);
  if (existsSync(`${root}/.claude/insensitive`)) add('insensitive', `${root}/.claude/insensitive`);
  for (const d of new Set([`${home}/.claude`, process.env.CLAUDE_CONFIG_DIR].filter(Boolean))) if (existsSync(`${d}/insensitive`)) add('insensitive', `${d}/insensitive`);
  if (explicit) { if (!MODES.includes(String(explicit).toLowerCase())) throw new Error(`mode must be one of ${MODES.join(' | ')}`); add(String(explicit).toLowerCase(), 'mode argument (user request)'); }
  const pick = found.find((f) => f.mode === 'sensitive') || found.find((f) => f.mode === 'insensitive') || { mode: 'blueprint', src: 'default' };
  return { mode: pick.mode, source: pick.src, all: found };
}
function checkDelegation({ agent, tier, mechanical, prompt, mode }) {
  if (!tier) throw new Error('tier is required: "easy" or "medium" (delegable) - or "hard"/"unsure" (stay on Claude). ' + TIER_RULE);
  if (!['easy', 'medium', 'hard', 'unsure'].includes(tier)) throw new Error('tier must be easy | medium | hard | unsure');
  if (tier === 'hard' || tier === 'unsure') throw new Error(`refused by delegation policy: tier "${tier}" stays on Claude (unsure = one tier harder). ${TIER_RULE}`);
  if (!ROSTER[agent]) throw new Error(`unknown agent "${agent}"; roster: ${Object.keys(ROSTER).join(', ')}`);
  if (mode === 'sensitive') {
    if (['designer', 'general'].includes(agent)) throw new Error(`SENSITIVE mode: agent "${agent}" is not delegated (allowed: explorer, librarian, deep-research, oracle, and fixer/worker only for mechanical work).`);
    if (EDITORS.has(agent) && !mechanical) throw new Error(`SENSITIVE mode: "${agent}" may only do strictly mechanical boilerplate / text replacement - pass mechanical:true if that is what this is, otherwise keep the work on Claude.`);
  }
  for (const re of SECRET_RES) if (re.test(prompt)) throw new Error('refused: the prompt looks like it contains a secret or credential (pattern ' + re.source.slice(0, 30) + '...). Never hand secrets to opencode; pass a path or an env var name instead.');
}
const AGENT_RULE = (agent) => READ_ONLY.has(agent)
  ? 'READ-ONLY: do not create, modify or delete any file and do not run state-changing commands; report findings with file paths.'
  : 'You may edit only the files named in the task. Run the build/test command given in the task and fix errors until it passes; end with the list of files changed and the test output.';
const INSTRUCTIONS = [
  'opencode-bridge: delegate easy/medium work to opencode (cheap model) and watch every opencode session. Routing policy is enforced by the tools, not optional.',
  'MODES (call opencode_policy to see which is active for a directory; SENSITIVE wins): ' + Object.values(MODE_RULES).join(' | '),
  'TIERS: ' + TIER_RULE,
  'WORKFLOW: opencode_start needs tier (easy|medium) and agent (' + Object.keys(ROSTER).join('|') + '); then poll opencode_status / opencode_result with wait_s (a bounded wait, at most 25 s per call; a long job answers still_running with its progress, poll again); see all sessions with opencode_sessions (state=running for what is active now) and read one with opencode_session_output. ' + VERIFY_RULE,
  'LIMITS AND ERRORS: at most OPENCODE_BRIDGE_MAX_PARALLEL tasks run at once (default 6) and each has a timeout (default 120 min, process group killed). Failures are classified in opencode_result (rate_limit, quota, context_length, output_limit, overloaded, auth, model, agent, step_limit, invalid_request, network, timeout, spawn, exit) with advice; interrupted and lost are separate outcomes, not failures. Only TRANSIENT errors (rate_limit, overloaded, network) of READ-ONLY agents that produced no output are retried automatically with backoff; an editing agent is never replayed. quota / auth / context_length / invalid_request are not retried: switch model, split the task, or keep the work on Claude. Prompts over ~100 KB are attached as a file.',
  'RESTARTS AND TIMEOUTS: tasks run detached and are stored in a state directory, so they survive a restart of this bridge or of Claude Code; after a restart opencode_list / opencode_status / opencode_result still work for them. No call blocks longer than ~28 s (wait_s is capped at 25 s). A task that ended as interrupted (client or service stopped) can be continued with opencode_resume (read-only agents directly; editing agents only with acknowledge_edits after you looked at git status). opencode_cancel also accepts a session id and cancels it through the opencode service.',
  'NAMING: every session title is "<LANE>/<agent>: <task>" (e.g. ALPHA/deep-research: collect API notes); opencode_start sets it, opencode_session_rename fixes old ones. The agent roster (explorer, librarian, deep-research, oracle, fixer, designer, general) comes from the opencode-config repository (https://github.com/Subhajit-Roy-Partho/opencode-config/tree/v2); without it only the built-in "worker" agent exists.',
].join('\n\n');

const S = { type: 'string' }, N = { type: 'number' }, B = { type: 'boolean' };
const tools = [
  { name: 'opencode_start', description: 'Delegate an EASY or MEDIUM job to an opencode agent (async; returns a task id). POLICY IS ENFORCED: `tier` is required and hard/unsure work is refused (it stays on Claude); the routing MODE (blueprint default | sensitive | insensitive; sensitive wins) is detected from env OPENCODE_MODE, <project>/.claude/sensitive|insensitive, ~/.claude/insensitive, or the `mode` argument, and limits the agents (sensitive: explorer, librarian, deep-research, oracle, and fixer/worker only with mechanical:true). Blueprint mode: give fixer/designer a written Blueprint (files, signatures, edge cases, acceptance criteria, test command). Prompts containing secrets are refused. The session is titled "<LANE>/<agent>: <task>". The task runs DETACHED and is stored on disk: it survives a restart of this bridge or of Claude Code. LIMITS: at most OPENCODE_BRIDGE_MAX_PARALLEL tasks at once (default 6), a per-task timeout, automatic retry (backoff) of transient provider errors for read-only agents only, prompts over ~100 KB are sent as an attached file. Verify the result yourself - it is an untrusted draft. Call opencode_policy for the full rules.',
    inputSchema: { type: 'object', required: ['prompt', 'tier'], properties: {
      prompt: { ...S, description: 'Full task: context, absolute paths, desired output, test command; the agent has no memory of this conversation' },
      tier: { ...S, description: 'easy | medium (delegable) | hard | unsure (refused: stays on Claude)' },
      agent: { ...S, description: `opencode agent: ${Object.keys(ROSTER).join(' | ')} (default: explorer in sensitive mode, otherwise worker)` },
      mechanical: { ...B, description: 'sensitive mode only: true = strictly mechanical boilerplate / text replacement' },
      mode: { ...S, description: 'blueprint | sensitive | insensitive - only when the user asked for a mode; sensitive always wins over other sources' },
      cwd: { ...S, description: 'Directory inside the allowed root' },
      model: { ...S, description: `provider/model[#variant]; default ${DEFAULT_MODEL || "opencode's own default (set OPENCODE_BRIDGE_MODEL to change)"}` }, session: { ...S, description: 'Previous task id to continue its session' },
      lane: { ...S, description: 'Lane / project short name for the session title (capitals), default = cwd name' },
      title: { ...S, description: 'Full session title; overrides the generated "<lane>/<agent>: <task>" (keep the convention)' },
      timeout_minutes: { ...N, description: `wall-clock limit, default ${DEFAULT_TIMEOUT_MIN} (1-1440); the process group is killed when it is reached` },
      wait_s: { ...N, description: `optional: wait up to this many seconds (cap ${MAX_WAIT_S}) and return the outcome if the task finishes in time` } } } },
  { name: 'opencode_policy', description: 'READ-ONLY. Show the delegation policy that opencode_start enforces: the ACTIVE routing mode for a directory and where it was detected, the agents allowed in that mode, the tier rules (what to delegate / keep), the verification rules and the roster. Call it before delegating if unsure which mode applies.',
    inputSchema: { type: 'object', properties: { cwd: { ...S, description: 'directory to evaluate (default: the bridge root)' }, mode: { ...S, description: 'preview what an explicit mode would do' } } } },
  { name: 'opencode_status', description: 'Status of a task started by this bridge or by an earlier instance of it (running / retrying / done / failed / timeout / cancelled / interrupted / lost), elapsed time and session id. Optional wait_s waits (bounded, at most 25 s) until the task finishes.', inputSchema: { type: 'object', required: ['id'], properties: { id: S, wait_s: { ...N, description: `wait up to this many seconds (cap ${MAX_WAIT_S}) for the task to finish` } } } },
  { name: 'opencode_result', description: 'Output of a task started by this bridge, with the failure kind and advice when it failed (rate_limit, quota, context_length, output_limit, overloaded, auth, model, agent, invalid_request, network, timeout, spawn, exit). interrupted (client or service stopped) is reported separately from failed, with advice. Large outputs are cut to the last 60000 characters unless `head` / `tail` is given. A running task answers with its progress; with wait_s (bounded, at most 25 s) the call waits for the outcome and otherwise returns [still_running] with progress and the next-poll hint.', inputSchema: { type: 'object', required: ['id'], properties: { id: S, tail: { ...N, description: 'only the last N characters' }, head: { ...N, description: 'only the first N characters' }, wait_s: { ...N, description: `wait up to this many seconds (cap ${MAX_WAIT_S}) for the task to finish` } } } },
  { name: 'opencode_cancel', description: 'Cancel a running or retrying task started by this bridge: the opencode service is asked to interrupt its session (abort endpoint) and its client process group gets SIGTERM, then SIGKILL; the task and its session are then shown as cancelled, not interrupted. `id` may also be a session id (ses_...) that no bridge task owns: it is interrupted through the service (use only for sessions you started). A finished task is reported as such.', inputSchema: { type: 'object', required: ['id'], properties: { id: { ...S, description: 'task id, or a session id (ses_...)' } } } },
  { name: 'opencode_resume', description: 'Continue a task that ended as interrupted, lost, failed, timeout or cancelled: starts a new task with the original prompt plus the progress so far (partial output, last steps). READ-ONLY agents (explorer, librarian, deep-research, oracle) resume directly. EDITING agents (fixer, designer, worker, general) are refused until you pass acknowledge_edits:true: the reply shows `git status --short` of the working directory so you can see what the interrupted run changed first, and the new run is told to inspect the tree before editing. same_session:true continues the same opencode session instead of starting a new one.', inputSchema: { type: 'object', required: ['id'], properties: { id: { ...S, description: 'task id (opencode_list)' }, acknowledge_edits: { ...B, description: 'editing agents: confirm you looked at the working tree and want the work continued' }, same_session: { ...B, description: 'continue the same opencode session (shorter prompt) instead of a new one' }, note: { ...S, description: 'extra instruction for the continued run' }, timeout_minutes: N } } },
  { name: 'opencode_list', description: 'List tasks started by this bridge and by earlier instances of it (persisted, newest 50 by default). For ALL opencode sessions use opencode_sessions.', inputSchema: { type: 'object', properties: { limit: { ...N, description: 'how many of the newest tasks (default 50, max 500)' }, state: { ...S, description: 'only this state, e.g. running | interrupted | failed | done' } } } },
  { name: 'opencode_sessions', description: 'READ-ONLY. List opencode sessions of the background service across all projects (newest first): id, state (running / succeeded / failed / interrupted / cancelled / stale?), agent, age, tokens, directory, title. Use state=running to see what is active now; a session whose last update is older than ~45 min and has no outcome is shown as "stale?".',
    inputSchema: { type: 'object', properties: {
      state: { ...S, description: 'running (default: all) | active | finished | succeeded | failed | interrupted | cancelled | stale | all' },
      agent: { ...S, description: 'only this agent, e.g. deep-research' },
      directory: { ...S, description: 'only sessions whose directory contains this text' },
      search: { ...S, description: 'only titles containing this text (server-side search)' },
      title_prefix: { ...S, description: 'only titles starting with this text, e.g. "ALPHA/"' },
      since_minutes: { ...N, description: 'only sessions updated in the last N minutes' },
      limit: { ...N, description: 'max rows (default 25, max 200)' },
      children: { ...B, description: 'include child (sub-task) sessions; default true' } } } },
  { name: 'opencode_session_output', description: 'READ-ONLY. Read what an opencode session did. mode "last" = the final assistant answer; "tail" (default) = the last N messages condensed (assistant text, tool calls with truncated input / result; reasoning is dropped); "full" = like tail but all fetched messages. Output is cut to max_chars from the end.',
    inputSchema: { type: 'object', required: ['id'], properties: {
      id: { ...S, description: 'session id (ses_...) from opencode_sessions' },
      mode: { ...S, description: 'last | tail | full (default tail)' },
      messages: { ...N, description: 'how many recent messages to fetch (default 12, max 200)' },
      max_chars: { ...N, description: 'output size cap (default 6000, max 60000)' },
      tool_chars: { ...N, description: 'chars kept of each tool input / result (default 220)' } } } },
  { name: 'opencode_session_rename', description: 'Set the title of an opencode session (the only write done on other sessions). Use the convention "<LANE>/<agent>: <task>".',
    inputSchema: { type: 'object', required: ['id', 'title'], properties: { id: S, title: S } } },
  { name: 'opencode_processes', description: 'READ-ONLY. OS-level view: running `opencode run` / opencode TUI processes (pid, elapsed, agent, title, working directory). Shows work that has no session in the service (e.g. --standalone runs) and processes that hang.', inputSchema: { type: 'object', properties: {} } },
];

function inside(dir) { const r = realpathSync(dir); return r === ROOT || r.startsWith(ROOT + '/'); }

// ---------- own tasks (v0.6: persistent, detached, supervised by a runner process) ----------
// A task is a directory STATE_DIR/tasks/<id>/ written by this bridge (spec) and by a detached RUNNER process
// (`server.mjs --runner <dir>`): the runner starts `opencode run`, sends its output to files, enforces the deadline, retries,
// falls back, and writes the final state. Neither a restart of this MCP server nor of Claude Code touches a running task;
// every bridge instance can read every task from the files (see docs/STATE.md).
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const cleanTitle = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
function makeTitle({ lane, agent, prompt, cwd }) {
  const l = (lane || basename(cwd) || 'BRIDGE').toUpperCase().replace(/[^A-Z0-9._-]+/g, '-');
  const first = String(prompt).split('\n').map((x) => x.trim()).find((x) => x && !/^rules?:/i.test(x)) || 'task';
  return cleanTitle(`${l}/${agent}: ${clip(first, 60)}`);
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const FINAL = new Set(['done', 'failed', 'timeout', 'cancelled', 'interrupted', 'lost']);
const isFinal = (s) => FINAL.has(s);
const TASKS_DIR = join(STATE_DIR, 'tasks'), CANCEL_DIR = join(STATE_DIR, 'cancelled');
const tdir = (id) => join(TASKS_DIR, id);
const ensureState = () => { for (const d of [TASKS_DIR, CANCEL_DIR]) mkdirSync(d, { recursive: true, mode: 0o700 }); };
function atomicWrite(file, data) { const tmpf = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`; writeFileSync(tmpf, data, { mode: 0o600 }); renameSync(tmpf, file); }
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const writeTask = (t) => atomicWrite(join(tdir(t.id), 'task.json'), JSON.stringify(t));
function readTask(id) { if (!/^[0-9a-f]{8}$/.test(String(id))) return null; const t = readJson(join(tdir(id), 'task.json')); if (!t) return null; t.runner ??= readJson(join(tdir(id), 'runner.json')); return t; }
function registry() { let ids = []; try { ids = readdirSync(TASKS_DIR); } catch {} return ids.map(readTask).filter(Boolean); }
const markCancelledSession = (sid) => { try { ensureState(); writeFileSync(join(CANCEL_DIR, String(sid).replace(/[^A-Za-z0-9_-]/g, '')), String(Date.now())); } catch {} };
const isCancelledSession = (sid) => { try { return existsSync(join(CANCEL_DIR, String(sid).replace(/[^A-Za-z0-9_-]/g, ''))); } catch { return false; } };

// process references {pid, start}: start = field 22 of /proc/<pid>/stat, so a recycled pid is not mistaken for our process
function procInfo(pid) { if (!PROCFS) return null; try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); const r = s.slice(s.lastIndexOf(')') + 2).split(' '); return { state: r[0], start: r[19] }; } catch { return null; } }
const pidRef = (pid) => ({ pid, start: procInfo(pid)?.start ?? null });
function pidAlive(p) {
  if (!p?.pid) return false;
  try { process.kill(p.pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  const i = procInfo(p.pid); if (i) { if (i.state === 'Z') return false; if (p.start && i.start !== p.start) return false; }
  return true;
}
function killRef(p, sig) { if (!pidAlive(p)) return false; try { process.kill(-p.pid, sig); return true; } catch { try { process.kill(p.pid, sig); return true; } catch { return false; } } } // the child is its own process group leader

function spawnFailure(e) {
  if (e?.code === 'ENOENT') return { kind: 'spawn', message: 'the opencode binary was not found on PATH', advice: 'Install opencode (>= 2) and make sure the process that runs the bridge has it on PATH.', transient: false };
  if (e?.code === 'E2BIG') return { kind: 'spawn', message: 'argument list too long', advice: 'The prompt did not fit on the command line (it is normally attached as a file automatically).', transient: false };
  return { kind: 'spawn', message: clip(e?.message ?? e, 300), advice: '', transient: false };
}

// The event stream of one attempt (`opencode run --format json`, one JSON object per line) is read incrementally from its file.
const evCache = new Map();
function newEv() { return { off: 0, partial: '', size: 0, lastAt: 0, sessionID: undefined, text: '', textTruncated: false, errors: [], steps: 0, tools: [], tokens: { input: 0, output: 0 } }; }
function readEvents(t) {
  const key = `${t.id}:${t.attempt || 1}`; let e = evCache.get(key);
  if (!e) { e = newEv(); evCache.set(key, e); if (evCache.size > 300) evCache.delete(evCache.keys().next().value); }
  let fd; try { fd = openSync(join(tdir(t.id), `out.${t.attempt || 1}.jsonl`), 'r'); } catch { return e; }
  try {
    const st = fstatSync(fd); if (st.size < e.off) Object.assign(e, newEv());
    e.size = st.size; e.lastAt = st.mtimeMs;
    const buf = Buffer.alloc(1 << 20);
    while (e.off < st.size) {
      const n = readSync(fd, buf, 0, buf.length, e.off); if (n <= 0) break; e.off += n;
      e.partial += buf.toString('utf8', 0, n); // (a multi-byte character cut at the chunk edge is repaired by the next chunk only for ASCII-safe JSON; events are JSON-escaped)
      const lines = e.partial.split('\n'); e.partial = lines.pop(); if (e.partial.length > 16_000_000) e.partial = '';
      for (const l of lines) ingest(e, l);
    }
  } catch {} finally { try { closeSync(fd); } catch {} }
  return e;
}
function ingest(e, l) {
  let j; try { j = JSON.parse(l); } catch { return; }
  if (!j || typeof j !== 'object') return;
  e.sessionID ||= j.sessionID;
  if (j.type === 'text') { e.text += j.part?.text ?? ''; if (e.text.length > MAX_TEXT) { e.text = e.text.slice(-MAX_TEXT); e.textTruncated = true; } }
  else if (j.type === 'error' && e.errors.length < 20) e.errors.push(errText(j.error ?? j.message ?? j));
  else if (j.type === 'step_start') e.steps++;
  else if (j.type === 'step_finish') { e.tokens.input += Number(j.part?.tokens?.input) || 0; e.tokens.output += Number(j.part?.tokens?.output) || 0; }
  else if (j.type === 'tool_use') { const p = j.part || {}; e.tools.push({ name: p.tool || '?', input: clip(typeof p.state?.input === 'string' ? p.state.input : JSON.stringify(p.state?.input ?? {}), 90), status: p.state?.status || '', at: j.timestamp || 0 }); if (e.tools.length > 6) e.tools.shift(); }
}
function readTailFile(file, n) { let fd; try { fd = openSync(file, 'r'); const st = fstatSync(fd); const len = Math.min(n, st.size); const b = Buffer.alloc(len); readSync(fd, b, 0, len, st.size - len); return b.toString('utf8'); } catch { return ''; } finally { try { closeSync(fd); } catch {} } }

const AUTO_ABORT = /aborted|session interrupted/i;
const FINALIZE_PROMPT = 'The step limit of this agent was reached (the provider rejects the forced final step). Do NOT call any more tools. Write your final report NOW from what you have already gathered: findings with file paths and line numbers, what is verified and what is not, open questions. If something is missing, say so instead of searching.';
function buildArgs(t, { sessionID, message } = {}) { // argv of one attempt
  const a = [...t.head];
  if (sessionID) a.push('-s', sessionID); else a.push('--title', t.title);
  if (t.attachFile) a.push('-f', t.attachFile);
  a.push(message ?? t.message);
  return a;
}
const lastAssistantText = (msgs) => { for (const m of msgs) { if (m.type !== 'assistant') continue; const tx = (m.content || []).filter((b) => b.type === 'text' && b.text).map((b) => b.text.trim()).join('\n'); if (tx) return tx; } return ''; }; // msgs: newest first (as the API returns them)

// ----- the runner: one detached process per task; survives the MCP server and Claude Code -----
async function runner(dir) {
  const rd = (f) => join(dir, f);
  let t = readJson(rd('task.json')); if (!t) process.exit(2);
  const save = (patch) => { t = { ...(readJson(rd('task.json')) || t), ...patch }; atomicWrite(rd('task.json'), JSON.stringify(t)); };
  const cancelled = () => existsSync(rd('cancelled'));
  let child = null, killedAt = 0;
  const stopChild = () => { if (!child || killedAt) return; killedAt = Date.now(); killRef(child, 'SIGTERM'); const h = setTimeout(() => killRef(child, 'SIGKILL'), KILL_GRACE_MS); h.unref?.(); };
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { writeFileSync(rd('cancelled'), String(Date.now()), { flag: 'a' }); } catch {} stopChild(); });
  process.on('SIGHUP', () => {});
  const cleanup = () => { if (t.attachDir) { try { rmSync(t.attachDir, { recursive: true, force: true }); } catch {} } };
  const end = (status, failure = null, extra = {}) => { // a cancel (marker file) always wins
    cleanup();
    if (cancelled() && status !== 'done') { status = 'cancelled'; failure = null; }
    save({ status, failure, ended: Date.now(), retryAt: null, ...extra }); process.exit(0);
  };
  const wait = async (ms) => { const until = Date.now() + ms; while (Date.now() < until && !cancelled()) await sleepMs(Math.min(200, until - Date.now())); };
  let attempt = t.attempt || 0, sessionID = t.resumeSession, finalizeMsg = null, fallback = null;
  const attemptText = () => readEvents({ id: t.id, attempt });
  for (;;) {
    if (cancelled()) end('cancelled');
    if (Date.now() > t.deadline) end('timeout', { kind: 'timeout', message: `no result after ${Math.round(t.timeoutMs / 1000)} s`, advice: 'Split the task into smaller pieces or raise timeout_minutes / OPENCODE_BRIDGE_TIMEOUT_MIN. Any partial output is in opencode_result.', transient: false });
    attempt++;
    const argv = buildArgs(t, { sessionID: sessionID || undefined, message: finalizeMsg || undefined });
    let spawnErr = null, timedOut = false;
    const o = openSync(rd(`out.${attempt}.jsonl`), 'a', 0o600), er = openSync(rd(`err.${attempt}.log`), 'a', 0o600);
    killedAt = 0; child = null;
    const exited = new Promise((resolve) => {
      let p; try { p = spawn('opencode', argv, { cwd: t.cwd, detached: true, stdio: ['ignore', o, er], env: { ...process.env, PWD: t.cwd, ...(t.backend === 'standalone' ? { OPENCODE_CONFIG_CONTENT: WORKER_CONFIG } : {}) } }); } // opencode resolves its project dir from $PWD, not the spawn cwd
      catch (e) { spawnErr = e; return resolve({}); }
      child = pidRef(p.pid);
      p.on('error', (e) => { spawnErr = e; resolve({}); });
      p.on('exit', (code, sig) => resolve({ code, sig }));
      save({ attempt, child, status: 'running', retryAt: null, ...(sessionID ? { sessionID } : {}), ...(finalizeMsg ? { fallback: 'finalize-in-session' } : {}) });
    });
    closeSync(o); closeSync(er);
    const timer = setInterval(() => {
      const ev = attemptText();
      if (ev.sessionID && ev.sessionID !== t.sessionID) save({ sessionID: ev.sessionID });
      if (!timedOut && Date.now() > t.deadline) { timedOut = true; stopChild(); }
      if (cancelled()) stopChild();
    }, 250);
    const { code, sig } = await exited; clearInterval(timer);
    const ev = attemptText(); if (ev.sessionID) sessionID = ev.sessionID; else sessionID ||= t.sessionID;
    const errTail = readTailFile(rd(`err.${attempt}.log`), 4000);
    const baseExtra = { exitCode: code ?? null, signal: sig ?? null, ...(sessionID ? { sessionID } : {}) };
    if (cancelled()) end('cancelled', null, baseExtra);
    if (spawnErr) end('failed', spawnFailure(spawnErr), baseExtra);
    if (timedOut) end('timeout', { kind: 'timeout', message: `no result after ${t.timeoutMs >= 60000 ? Math.round(t.timeoutMs / 60000) + ' min' : t.timeoutMs + ' ms'}; the process group was killed`, advice: 'Split the task into smaller pieces or raise timeout_minutes / OPENCODE_BRIDGE_TIMEOUT_MIN. Any partial output is in opencode_result.', transient: false }, baseExtra);
    // The client died (signal / crash) but the service may still be running the session: attach to it instead of declaring a loss.
    let svc = null;
    if (t.backend === 'service' && sessionID && (sig || (code !== 0 && !ev.errors.length))) svc = await reattach(sessionID, { deadline: t.deadline, stop: cancelled });
    if (svc?.outcome === 'succeeded') { if (svc.text) writeFileSync(rd('result.txt'), svc.text, { mode: 0o600 }); end('done', null, { ...baseExtra, reattached: true }); }
    if (svc?.outcome === 'interrupted') end('interrupted', { kind: 'interrupted', message: 'the session was interrupted in the service' + (sig ? ` (client killed by ${sig})` : ''), advice: INTERRUPTED_ADVICE, transient: false }, { ...baseExtra, reattached: true });
    let failure = null;
    if (svc?.outcome === 'failed') { const c = classify(svc.error); failure = { kind: c.kind === 'other' ? 'exit' : c.kind, message: clip(svc.error, 400), advice: c.advice, transient: c.transient }; }
    else if (code !== 0 || (ev.errors.length && !ev.text)) {
      const errs = ev.errors.join(' ');
      if (!ev.errors.length && sig) end('interrupted', { kind: 'interrupted', message: `the opencode client was killed by ${sig} before it reported an outcome`, advice: INTERRUPTED_ADVICE, transient: false }, baseExtra);
      if (ev.errors.length && ev.errors.every((x) => AUTO_ABORT.test(x))) end('interrupted', { kind: 'interrupted', message: clip(ev.errors[0], 300), advice: INTERRUPTED_ADVICE, transient: false }, baseExtra);
      const msg = ev.errors[0] || errTail.trim().split('\n').filter(Boolean).slice(-1)[0] || (sig ? `killed by signal ${sig}` : `exit code ${code}`);
      const c = classify(`${errs} ${errTail}`);
      failure = { kind: c.kind === 'other' ? (sig ? 'signal' : 'exit') : c.kind, message: clip(msg, 400), advice: c.advice, transient: c.transient };
    }
    if (!failure) end('done', null, baseExtra);
    // step limit (provider rejects the forced last step): let a read-only agent finish its report in the same session, once
    if (failure.kind === 'step_limit' && READ_ONLY.has(t.agent) && sessionID && !finalizeMsg) { finalizeMsg = `${guardFor(t.agent)}\n${AGENT_RULE(t.agent)}\n\n${FINALIZE_PROMPT}`; fallback = 'finalize-in-session'; save({ ...baseExtra, fallbackNote: `attempt ${attempt} hit the step limit (${failure.message.slice(0, 80)}); the report was requested in the same session` }); continue; }
    // retry only what is safe to replay: transient provider/network errors of READ-ONLY agents that produced no output yet
    if (failure.transient && READ_ONLY.has(t.agent) && !ev.text && attempt <= t.maxRetries) {
      const delay = t.retryDelayMs * 3 ** (attempt - 1);
      save({ ...baseExtra, status: 'retrying', failure, retryAt: Date.now() + delay, attempt }); await wait(delay); continue;
    }
    end('failed', failure, baseExtra);
  }
}
const INTERRUPTED_ADVICE = 'The run was stopped before it reported an outcome (the client or the opencode service was stopped or restarted, the machine slept, or someone interrupted the session). It is not a provider failure. Partial work is in the session history (opencode_session_output). Read-only agents: opencode_resume continues it; editing agents: check `git status` first (opencode_resume shows it and needs acknowledge_edits).';
// One consistent look at a session: its record and whether the service is running it. A session can finish between the two
// requests, so a record without an outcome that is not active is read once more.
async function sessionState(sid) {
  let s = (await api('GET', `/api/session/${encodeURIComponent(sid)}`)).data;
  const active = (await activeIds()).has(sid);
  if (!active && s && !s.outcome) s = (await api('GET', `/api/session/${encodeURIComponent(sid)}`)).data;
  return { s, active };
}
// Poll the service for a session whose client is gone. Returns {outcome, text?, error?} or null when the session cannot be found.
async function reattach(sid, { deadline = Infinity, stop = () => false } = {}) {
  let fails = 0, first = true;
  for (;;) {
    let s, active;
    try { ({ s, active } = await sessionState(sid)); fails = 0; } catch { if (first || ++fails >= 3) return null; await sleepMs(REATTACH_POLL_MS); continue; }
    first = false;
    if (!s || typeof s !== 'object') return null;
    // an active session is running whatever an earlier turn left in `outcome`
    if (!active && s.outcome) {
      let text = '', error = '';
      try { const m = (await api('GET', `/api/session/${encodeURIComponent(sid)}/message`, { limit: 40 })).data ?? []; text = lastAssistantText(m); error = errText(m.map((x) => x.error).find(Boolean)); } catch {}
      return { outcome: s.outcome, text, error };
    }
    if (!active && Date.now() - (s.time?.updated ?? s.time?.created ?? 0) > REATTACH_QUIET_MS) return { outcome: 'interrupted', text: '', error: '' };
    if (stop() || Date.now() > deadline) return null;
    await sleepMs(REATTACH_POLL_MS);
  }
}

// ----- the bridge side: snapshots of tasks, reconcile, start / cancel / resume -----
const live = (s) => !isFinal(s.status);
async function snap(id) {
  const t = readTask(id); let inRoot = false; try { inRoot = !!t && inside(t.cwd); } catch {}
  if (!t || !inRoot) throw new Error('unknown task (opencode_list shows this bridge\'s tasks; for any other session use opencode_sessions)');
  const ev = readEvents(t);
  let status = t.status, note = '';
  if (!isFinal(status)) {
    const runnerUp = pidAlive(t.runner), childUp = pidAlive(t.child);
    if (runnerUp) { /* supervised */ }
    else if (!t.runner && Date.now() - t.started < 15000) { /* the runner is starting */ }
    else if (childUp) { note = 'supervisor process gone, the run continues'; if (Date.now() > t.deadline) { killRef(t.child, 'SIGTERM'); const h = setTimeout(() => killRef(t.child, 'SIGKILL'), KILL_GRACE_MS); h.unref?.(); } }
    else {
      // The runner writes its final state BEFORE it exits, so once it is seen dead the file is definitive: read it again
      // (a record read earlier may predate that write).
      const fresh = readTask(id);
      if (fresh && isFinal(fresh.status)) { Object.assign(t, fresh); status = t.status; }
      else { const patch = await reconcile(t, ev); if (patch) { Object.assign(t, patch); status = t.status; } else note = 'the opencode service could not be asked about this session'; }
    }
  }
  const textFile = join(tdir(id), 'result.txt');
  const text = existsSync(textFile) ? readFileSync(textFile, 'utf8') : ev.text;
  return { t, ev, status, text, note };
}
// The runner is gone and so is its opencode client, without a final record: ask the service what became of the session.
async function reconcile(t, ev) {
  const done = (status, failure, extra = {}) => { const cur = readTask(t.id); if (cur && isFinal(cur.status)) return cur; /* never overwrite a final state */ const n = { ...(cur || t), status, failure, ended: Date.now(), retryAt: null, ...extra }; try { writeTask(n); } catch {} return n; };
  if (existsSync(join(tdir(t.id), 'cancelled'))) return done('cancelled', null);
  if (Date.now() > t.deadline) return done('timeout', { kind: 'timeout', message: `no result after ${Math.round(t.timeoutMs / 1000)} s; the supervisor was gone`, advice: 'Split the task into smaller pieces or raise timeout_minutes. Partial output is in opencode_result.', transient: false });
  const sid = ev.sessionID || t.sessionID;
  if (!sid) return done('lost', { kind: 'lost', message: 'the run ended before opencode created a session (the supervisor and the client are gone); nothing can be recovered', advice: 'Start the task again (opencode_start with the same prompt; opencode_resume re-sends it).', transient: false });
  let s, act; try { ({ s, active: act } = await sessionState(sid)); } catch (e) { if (/404|not found/i.test(String(e.message))) return done('lost', { kind: 'lost', message: `session ${sid} no longer exists in the service`, advice: 'Start the task again (opencode_resume re-sends it).', transient: false }); return null; }
  if (act || (!s?.outcome && Date.now() - (s?.time?.updated ?? 0) < REATTACH_QUIET_MS)) return { ...t, sessionID: sid, status: 'running' }; // still executing in the service, only its supervisor is gone: the next call asks again
  if (s?.outcome === 'succeeded') { let text = ''; try { text = lastAssistantText((await api('GET', `/api/session/${encodeURIComponent(sid)}/message`, { limit: 40 })).data ?? []); } catch {} if (text) writeFileSync(join(tdir(t.id), 'result.txt'), text, { mode: 0o600 }); return done('done', null, { sessionID: sid, reconciled: true }); }
  if (s?.outcome === 'failed') { let msg = ''; try { msg = errText(((await api('GET', `/api/session/${encodeURIComponent(sid)}/message`, { limit: 40 })).data ?? []).map((x) => x.error).find(Boolean)); } catch {} const c = classify(msg); return done('failed', { kind: c.kind === 'other' ? 'exit' : c.kind, message: clip(msg || 'the session failed', 400), advice: c.advice, transient: c.transient }, { sessionID: sid, reconciled: true }); }
  if (s?.outcome === 'interrupted') return done('interrupted', { kind: 'interrupted', message: 'the session was interrupted in the service', advice: INTERRUPTED_ADVICE, transient: false }, { sessionID: sid, reconciled: true });
  return done('interrupted', { kind: 'interrupted', message: 'the run ended without an outcome (client and supervisor gone, the service is not running the session)', advice: INTERRUPTED_ADVICE, transient: false }, { sessionID: sid, reconciled: true });
}

const elapsed = (t) => Math.round(((isFinal(t.status) ? t.ended ?? Date.now() : Date.now()) - t.started) / 1000);
function liveTasks() { return registry().sort((x, y) => x.started - y.started).filter((t) => !isFinal(t.status) && (pidAlive(t.runner) || pidAlive(t.child) || (!t.runner && Date.now() - t.started < 15000)) && (t.bridge?.pid === process.pid || !pidAlive(t.bridge))); }
function gitStatus(cwd) { try { return execFileSync('git', ['-C', cwd, 'status', '--short'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() || '(clean: no changes)'; } catch { return '(not a git repository, or git is unavailable: check the files yourself)'; } }

let lastStart = 0;
function start(a, { resume } = {}) {
  const str = (v) => (v === undefined || v === null ? undefined : String(v));
  const prompt = str(a.prompt)?.trim();
  if (!prompt) throw new Error('prompt is empty: pass the full task (context, absolute paths, desired output, test command)');
  if (Buffer.byteLength(prompt) > PROMPT_MAX) throw new Error(`prompt is too large (> ${PROMPT_MAX / 1e6} MB): put the material in files inside the working directory and reference their paths`);
  const cwdArg = str(a.cwd) || ROOT; let cwd;
  try { cwd = realpathSync(cwdArg); } catch { throw new Error(`cwd does not exist: ${cwdArg}`); }
  if (!(cwd === ROOT || cwd.startsWith(ROOT + '/'))) throw new Error(`cwd must be inside ${ROOT}`);
  const tier = str(a.tier)?.trim().toLowerCase();
  const model = str(a.model)?.trim() || DEFAULT_MODEL;
  const det = detectMode(cwd, str(a.mode)?.trim());
  const agent = str(a.agent)?.trim().toLowerCase() || (det.mode === 'sensitive' ? 'explorer' : process.env.OPENCODE_BRIDGE_AGENT || 'worker');
  checkDelegation({ agent, tier, mechanical: a.mechanical === true || a.mechanical === 'true', prompt: resume ? resume.userPrompt : prompt, mode: det.mode });
  const sessionArg = str(a.session)?.trim(); let prevSession;
  if (sessionArg) {
    if (/^ses_[A-Za-z0-9]+$/.test(sessionArg)) prevSession = sessionArg;
    else { const prev = readTask(sessionArg); if (!prev) throw new Error(`session continuation: unknown task id "${sessionArg}" (opencode_list shows this bridge's tasks)`); prevSession = prev.sessionID || readEvents(prev).sessionID; if (!prevSession) throw new Error('session continuation: that task has no session id yet (still starting, or it failed before a session was created)'); }
  }
  const running = liveTasks();
  if (running.length >= MAX_PARALLEL) throw new Error(`parallel limit reached (${running.length}/${MAX_PARALLEL} tasks running or waiting to retry): ${running.map((r) => `${r.id} ${r.agent} "${clip(r.title, 40)}"`).join('; ')}. Wait for one to finish (opencode_status), cancel one (opencode_cancel), or raise OPENCODE_BRIDGE_MAX_PARALLEL.`);
  const id = randomBytes(4).toString('hex');
  const finalTitle = cleanTitle(a.title) || makeTitle({ lane: str(a.lane), agent, prompt: resume ? resume.userPrompt : prompt, cwd });
  // roster agents run through the opencode service (the run survives its client and can be interrupted through the API);
  // the bridge's own `worker` is defined inline and needs a private (--standalone) instance
  const backend = BACKEND === 'auto' ? (agent === 'worker' ? 'standalone' : 'service') : BACKEND;
  const head = ['run', ...(backend === 'standalone' ? ['--standalone'] : []), '--agent', agent, '--auto', '--format', 'json', ...(model ? ['-m', model] : [])];
  const full = `${guardFor(agent)}\n${AGENT_RULE(agent)}\n\n${prompt}`;
  let message = full, attachDir = null, attachFile = null;
  ensureState();
  if (Buffer.byteLength(full) > ARG_LIMIT) { // one argv entry is limited to ~128 KiB on Linux: attach the task as a file instead
    attachDir = mkdtempSync(join(tmpdir(), 'ocb-')); attachFile = join(attachDir, 'task.md'); writeFileSync(attachFile, full, { mode: 0o600 });
    message = `${guardFor(agent)}\n${AGENT_RULE(agent)}\n\nThe complete task is in the attached file task.md. Read it first and follow it exactly.`;
  }
  const timeoutMin = num(a.timeout_minutes, DEFAULT_TIMEOUT_MIN, 1, 1440), timeoutMs = timeoutMin * TIMEOUT_UNIT_MS;
  const started = (lastStart = Math.max(Date.now(), lastStart + 1)); // strictly increasing: the order of tasks is the order of starting
  const t = { v: 1, id, status: 'running', started, deadline: started + timeoutMs, timeoutMin, timeoutMs, mode: det.mode, agent, tier, title: finalTitle, cwd, model, backend, head, message, attachDir, attachFile, resumeSession: prevSession, maxRetries: MAX_RETRIES, retryDelayMs: RETRY_DELAY_MS, attempt: 0, failure: null, bridge: pidRef(process.pid), mechanical: a.mechanical === true || a.mechanical === 'true', lane: str(a.lane) || null, ...(resume ? { resumeOf: resume.of } : {}) };
  mkdirSync(tdir(id), { recursive: true, mode: 0o700 });
  writeFileSync(join(tdir(id), 'prompt.md'), resume ? resume.userPrompt : prompt, { mode: 0o600 });
  writeTask(t);
  spawnRunner(t);
  const hint = det.mode === 'blueprint' && EDITORS.has(agent) ? ' Blueprint mode: make sure the prompt is a written Blueprint (files, signatures, acceptance criteria, test command).' : det.mode === 'insensitive' ? ' Insensitive mode: prefer parallel lanes (several tasks at once).' : '';
  const lim = `Limits: ${running.length + 1}/${MAX_PARALLEL} parallel, timeout ${timeoutMin} min${READ_ONLY.has(agent) ? `, up to ${MAX_RETRIES} automatic retries of transient provider errors` : ', no automatic retry (editing agent)'}${attachFile ? `, prompt ${Math.round(Buffer.byteLength(full) / 1024)} KB sent as an attached file` : ''}.`;
  return { id, text: `task ${id} started | mode=${det.mode} (${det.source}) agent=${agent} tier=${tier} | title: ${finalTitle}\nNext: opencode_status / opencode_result with wait_s (up to ${MAX_WAIT_S} s per call), or opencode_session_output on the session id. The run is detached: it survives a restart of this bridge or of Claude Code (state in ${STATE_DIR}). ${lim} ${VERIFY_RULE}${hint}` };
}
function spawnRunner(t) {
  const dir = tdir(t.id); const lf = openSync(join(dir, 'runner.log'), 'a', 0o600);
  let p; try { p = spawn(RUNNER_CMD[0], [...RUNNER_CMD.slice(1), '--runner', dir], { detached: true, stdio: ['ignore', lf, lf], env: process.env, cwd: dir }); } catch (e) { closeSync(lf); return failStart(t, e); }
  closeSync(lf);
  p.on('error', (e) => failStart(t, e)); p.unref();
  if (p.pid) atomicWrite(join(dir, 'runner.json'), JSON.stringify(pidRef(p.pid)));
}
function failStart(t, e) { try { writeTask({ ...(readTask(t.id) || t), status: 'failed', failure: spawnFailure(e), ended: Date.now() }); } catch {} }

async function cancelTask(id) {
  let s = await snap(id); const t = s.t;
  if (isFinal(s.status)) return `task already ${s.status}; nothing to cancel`;
  if (existsSync(join(tdir(id), 'cancelled'))) return 'task already cancelled; nothing to cancel';
  ensureState(); writeFileSync(join(tdir(id), 'cancelled'), String(Date.now())); // first: no retry, no overwrite of the final state
  const sid = t.sessionID || s.ev.sessionID; const notes = [];
  if (sid) markCancelledSession(sid);
  if (t.backend === 'service' && sid && pidAlive(t.child)) { try { const r = await api('POST', `/api/session/${encodeURIComponent(sid)}/interrupt`); notes.push(r.interrupted ? `session ${sid} interrupted through the service` : `the service reported no active execution for ${sid}`); } catch (e) { notes.push(`service interrupt failed (${clip(e.message, 120)}); the client process was stopped instead`); } }
  killRef(t.child, 'SIGTERM'); const h = setTimeout(() => killRef(t.child, 'SIGKILL'), KILL_GRACE_MS); h.unref?.();
  if (pidAlive(t.runner)) { try { process.kill(t.runner.pid, 'SIGTERM'); } catch {} }
  else { try { writeTask({ ...readTask(id), status: 'cancelled', failure: null, ended: Date.now(), retryAt: null }); } catch {} }
  return ['cancelled', ...notes].join('\n');
}
async function cancelSession(sid) { // a session no bridge task owns: through the service's abort endpoint
  const r = await api('POST', `/api/session/${encodeURIComponent(sid)}/interrupt`);
  if (!r.interrupted) return `session ${sid}: the service has no active execution to interrupt (it is idle or finished, or it is a --standalone run owned by its own client process: opencode_processes shows that pid; stop it with a pid-specific kill)`;
  markCancelledSession(sid);
  let st = ''; for (let i = 0; i < 8 && !st; i++) { await sleepMs(250); try { const s = (await api('GET', `/api/session/${encodeURIComponent(sid)}`)).data; if (s?.outcome) st = s.outcome; } catch {} }
  return `cancelled: session ${sid} interrupted through the service (service outcome: ${st || 'pending'}; the bridge lists it as cancelled)`;
}
async function cancel(a) {
  const id = String(a.id ?? '').trim();
  if (/^ses_[A-Za-z0-9]+$/.test(id)) { const own = registry().find((t) => t.sessionID === id && !isFinal(t.status)); return own ? cancelTask(own.id) : cancelSession(id); }
  return cancelTask(id);
}

// opencode_resume: a new task from an interrupted / failed / lost one, with the original prompt and the progress so far
async function resume(a) {
  const s = await snap(String(a.id ?? '')); const t = s.t;
  if (!isFinal(s.status)) throw new Error(`task ${t.id} is still ${s.status}; nothing to resume (opencode_status / opencode_result show its progress)`);
  if (s.status === 'done') throw new Error(`task ${t.id} finished successfully; read it with opencode_result (to run it again, use opencode_start)`);
  const editing = !READ_ONLY.has(t.agent);
  const tree = editing ? gitStatus(t.cwd) : '';
  if (editing && !(a.acknowledge_edits === true || a.acknowledge_edits === 'true')) throw new Error(`task ${t.id} used the EDITING agent "${t.agent}": it may have changed files before it stopped, and replaying it blindly can duplicate or clash with those changes. Working tree of ${t.cwd} right now (git status --short):\n${tree}\nInspect it (git diff), then call opencode_resume again with acknowledge_edits:true; the new run is told to inspect the tree first. Or finish the work yourself.`);
  const original = readFileSync(join(tdir(t.id), 'prompt.md'), 'utf8');
  const partial = s.text ? s.text.slice(-6000) : '';
  const tools = s.ev.tools.map((x) => `${x.name}(${x.input}) [${x.status}]`).join('\n  ');
  const ctx = [`RESUME: an earlier run of this task (id ${t.id}${t.sessionID ? ', session ' + t.sessionID : ''}) ended as "${s.status}"${t.failure ? ': ' + t.failure.message : ''}. Continue from where it stopped; do not redo finished work.`,
    partial ? `Output of the earlier run (last part):\n${partial}` : 'The earlier run produced no output.', tools ? `Its last steps:\n  ${tools}` : '',
    editing ? 'The working tree may contain PARTIAL EDITS of the earlier run. Run `git status` and `git diff` first, keep what is correct, finish the rest.' : '',
    a.note ? `Extra instruction: ${String(a.note).slice(0, 2000)}` : ''].filter(Boolean).join('\n\n');
  const sameSession = a.same_session === true || a.same_session === 'true';
  const r = start({ prompt: sameSession ? `${ctx}\n\nContinue and finish the task.` : `${original}\n\n---\n${ctx}`, tier: t.tier, agent: t.agent, mechanical: t.mechanical, cwd: t.cwd, model: t.model || undefined, lane: t.lane || undefined, title: t.title.replace(/( \(resume\))*$/, ' (resume)'), mode: t.mode, timeout_minutes: a.timeout_minutes ?? t.timeoutMin, session: sameSession ? (t.sessionID || s.ev.sessionID) : undefined }, { resume: { of: t.id, userPrompt: original } });
  return `${r.text}\nResumed task ${t.id} (${s.status}) as ${r.id} ${sameSession ? 'in the same session' : 'in a new session with the original prompt plus the progress so far'}.${editing ? `\nWorking tree at the time of the resume (git status --short):\n${tree}` : ''}`;
}

function policy({ cwd = ROOT, mode } = {}) {
  if (!inside(cwd)) throw new Error(`cwd must be inside ${ROOT}`);
  const det = detectMode(realpathSync(cwd), mode);
  const allowed = det.mode === 'sensitive' ? ['explorer', 'librarian', 'deep-research', 'oracle', 'fixer (mechanical:true only)', 'worker (mechanical:true only)'] : Object.keys(ROSTER);
  return [`ACTIVE MODE: ${det.mode.toUpperCase()}  (source: ${det.source}${det.all.length > 1 ? '; also seen: ' + det.all.map((f) => `${f.mode} via ${f.src}`).join(', ') : ''})`,
    `directory evaluated: ${realpathSync(cwd)}`, '', MODE_RULES[det.mode], '', `Agents allowed here: ${allowed.join(', ')}`, '', 'TIERS: ' + TIER_RULE, '', 'VERIFY: ' + VERIFY_RULE, '',
    'ROSTER:\n' + Object.entries(ROSTER).map(([k, v]) => `  ${k.padEnd(14)} ${v}`).join('\n'), '',
    `LIMITS: ${MAX_PARALLEL} parallel tasks, timeout ${DEFAULT_TIMEOUT_MIN} min, ${MAX_RETRIES} automatic retries (read-only agents, transient errors only), waits of at most ${MAX_WAIT_S} s per call, tool output capped at ${RESPONSE_CAP} characters. Error kinds and advice: see opencode_result.`, '',
    'Detection order (SENSITIVE wins): env OPENCODE_BRIDGE_MODE / OPENCODE_MODE; <project>/.claude/sensitive; <project>/.claude/insensitive; ~/.claude/insensitive and $CLAUDE_CONFIG_DIR/insensitive; the `mode` argument when the user asked. Default: blueprint.',
    'Roster agents are defined in https://github.com/Subhajit-Roy-Partho/opencode-config/tree/v2 (install it as ~/.config/opencode). Policy text: "OpenCode Specialist Delegation" in CLAUDE.md.'].join('\n');
}

// ----- status / result with bounded waits and progress -----
const ageS = (ms) => (ms ? Math.max(0, Math.round((Date.now() - ms) / 1000)) : null);
function progressLine(s) {
  const { t, ev } = s; const bits = [`${elapsed(t)}s elapsed`];
  if (ev.steps) bits.push(`${ev.steps} step(s)`);
  if (ev.tokens.input || ev.tokens.output) bits.push(`${k(ev.tokens.input)}/${k(ev.tokens.output)} tok`);
  const last = ev.tools[ev.tools.length - 1];
  if (last) bits.push(`last tool ${last.name}(${clip(last.input, 60)})`);
  if (ev.lastAt) bits.push(`last output ${ageS(ev.lastAt)}s ago`);
  if (s.text) bits.push(`${s.text.length} chars of text`);
  return bits.join(', ');
}
function staleNote(s) { const q = s.ev.lastAt ? (Date.now() - s.ev.lastAt) / 60000 : 0; return !isFinal(s.status) && q > STALE_MIN ? ` [stale?: no output for ${Math.round(q)} min]` : ''; }
function statusText(s) {
  const { t } = s;
  return `${s.status}${t.failure ? ` (${t.failure.kind})` : ''}${s.status === 'retrying' ? ` in ${Math.max(0, Math.round((t.retryAt - Date.now()) / 1000))}s` : ''} (${elapsed(t)}s, ${s.text.length} chars${t.sessionID || s.ev.sessionID ? ', session ' + (t.sessionID || s.ev.sessionID) : ''}${t.attempt > 1 ? `, attempt ${t.attempt}` : ''}) ${t.agent}/${t.tier}/${t.mode}${s.status === 'done' && s.ev.errors.length ? ` [${s.ev.errors.length} error event(s) during the run]` : ''}${staleNote(s)}${t.fallback ? ' [fallback: ' + t.fallback + ']' : ''}${s.note ? ` [${s.note}]` : ''}`;
}
function resultText(s, a) {
  const { t } = s;
  const lines = [`[${s.status}${t.failure ? ': ' + t.failure.kind : ''}]`];
  if (t.failure) { lines.push(t.failure.message); if (t.failure.advice) lines.push('Advice: ' + t.failure.advice); }
  if (s.status === 'interrupted' || s.status === 'lost') lines.push(`recoverable: ${s.status === 'lost' ? 'no session exists, start the task again (opencode_resume re-sends the prompt)' : READ_ONLY.has(t.agent) ? `yes, read-only agent: opencode_resume id=${t.id}` : `partly: editing agent, check \`git status\` then opencode_resume id=${t.id} acknowledge_edits:true`}`);
  if (t.fallback) lines.push(`fallback used: ${t.fallback}${t.fallbackNote ? ' (' + t.fallbackNote + ')' : ''}`);
  if (s.status === 'retrying') lines.push(`waiting ${Math.max(0, Math.round((t.retryAt - Date.now()) / 1000))}s before attempt ${t.attempt + 1} of ${MAX_RETRIES + 1}`);
  if (live(s)) { lines.push(`progress: ${progressLine(s)}${s.note ? ` [${s.note}]` : ''}${staleNote(s)}`); }
  if (!t.failure && s.ev.errors.length) lines.push(`warning: ${s.ev.errors.length} error event(s) during the run, first: ${clip(s.ev.errors[0], 200)}`);
  if (s.ev.textTruncated) lines.push(`note: the output exceeded ${MAX_TEXT / 1e6} MB; only the last ${MAX_TEXT / 1e6} MB are kept`);
  let body = s.text || (t.failure || s.status === 'cancelled' ? '' : '(no output yet)');
  const tailN = num(a.tail, 0, 0, 5e7), headN = num(a.head, 0, 0, 5e7);
  if (tailN && body.length > tailN) body = body.slice(-tailN); else if (headN && body.length > headN) body = body.slice(0, headN);
  else if (!tailN && !headN && body.length > RESULT_CAP) { lines.push(`note: ${body.length - RESULT_CAP} earlier characters omitted (output is ${body.length}); pass head=N for the beginning or tail=N for a different size`); body = body.slice(-RESULT_CAP); }
  if (t.failure && body) lines.push('--- partial output ---');
  return lines.join('\n') + (body ? '\n' + body : '');
}
const waitArg = (a) => num(a.wait_s ?? a.timeout_s, 0, 0, MAX_WAIT_S);
// Wait for a final state for at most `secs` (capped), sending MCP progress notifications through ctx.progress; returns the last snapshot.
async function waitTask(id, secs, ctx = {}) {
  const end = Date.now() + secs * 1000; let s = await snap(id);
  while (secs > 0 && live(s) && Date.now() < end && !ctx.aborted) { await sleepMs(Math.min(WAIT_POLL_MS, Math.max(1, end - Date.now()))); s = await snap(id); ctx.progress?.(`${s.status}: ${progressLine(s)}`); }
  return s;
}
const stillRunning = (s, secs) => `[still_running] task ${s.t.id} is ${s.status} after waiting ${secs} s; this is normal for a long job and nothing is lost.\nprogress: ${progressLine(s)}${s.note ? ` [${s.note}]` : ''}${staleNote(s)}\nNext: poll again with opencode_result id=${s.t.id} wait_s=${MAX_WAIT_S} (about every ${MAX_WAIT_S} s)${s.t.sessionID || s.ev.sessionID ? `, or read the steps with opencode_session_output id=${s.t.sessionID || s.ev.sessionID} mode=tail` : ''}.`;

// ---------- session visibility (v0.2) ----------
// All calls go through `opencode api`, which knows how to reach and authenticate to the background service.
function apiError(method, path, err, stderr) {
  const raw = String(stderr || '').trim();
  const line = (raw.split('\n').map((l) => l.trim()).find((l) => /^Error:|HTTP \d{3}/.test(l)) || raw.split('\n').find((l) => l.trim()) || err.message || '').trim();
  let msg, transient = false;
  if (err.code === 'ENOENT') msg = 'the opencode binary was not found on PATH (install opencode >= 2 and make sure the process running the bridge has it on PATH)';
  else if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') msg = 'the reply was too large (> 64 MB): ask for fewer messages / a smaller limit';
  else if (err.killed || err.signal) { msg = `timed out after ${API_TIMEOUT_MS >= 1000 ? Math.round(API_TIMEOUT_MS / 1000) + ' s' : API_TIMEOUT_MS + ' ms'} (the opencode service is busy or hung; retry, or restart it)`; transient = true; }
  else if (/ECONNREFUSED|Could not reach server|ECONNRESET|EPIPE/i.test(raw)) { msg = 'the opencode background service is not reachable (is it running? start opencode once, or run `opencode service` ...). ' + clip(line, 160); transient = /ECONNRESET|EPIPE/i.test(raw); }
  else if (/Authentication required|\b401\b|Unauthorized/i.test(raw)) msg = 'authentication was refused by the opencode service (' + clip(line, 120) + ')';
  else msg = clip(line || 'unknown error', 240);
  return { error: new Error(`opencode api ${method} ${path} failed: ${msg}`), transient };
}
function apiOnce(method, path, query, body) {
  const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
  const args = ['api', method, q ? `${path}?${q}` : path];
  if (body !== undefined) args.push('-d', JSON.stringify(body));
  return new Promise((resolve, reject) => {
    execFile('opencode', args, { timeout: API_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL', env: { ...process.env, PWD: process.cwd() } }, (err, stdout, stderr) => {
      if (err) { const e = apiError(method, path, err, stderr); e.error.transient = e.transient; return reject(e.error); }
      const s = stdout.trim();
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch { reject(new Error(`opencode api ${method} ${path} failed: non-JSON reply: ${clip(s, 200)}`)); }
    });
  });
}
async function api(method, path, query = {}, body) {
  try { return await apiOnce(method, path, query, body); }
  catch (e) { if (method === 'GET' && e.transient) { await new Promise((r) => setTimeout(r, 400)); return apiOnce(method, path, query, body); } throw e; } // reads are safe to repeat once
}

const ago = (ms) => { const m = (Date.now() - ms) / 60000; return m < 1 ? '<1m' : m < 90 ? `${Math.round(m)}m` : m < 2880 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`; };
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0));
const tail = (p, n = 2) => String(p || '').split('/').filter(Boolean).slice(-n).join('/');

function stateOf(s, activeIds) {
  if (s.outcome) return s.outcome === 'interrupted' && isCancelledSession(s.id) ? 'cancelled' : s.outcome; // an interrupt that the bridge asked for is "cancelled", not a crash
  if (activeIds.has(s.id)) return 'running';
  const upd = s.time?.updated ?? s.time?.created ?? 0;
  return (Date.now() - upd) / 60000 > STALE_MIN ? 'stale?' : 'running';
}

async function activeIds() {
  try {
    const r = await api('GET', '/api/session/active');
    const d = r.data ?? r;
    if (Array.isArray(d)) return new Set(d.map((x) => (typeof x === 'string' ? x : x?.id ?? x?.sessionID)).filter(Boolean));
    return new Set(Object.keys(d || {}));
  } catch { return new Set(); }
}

async function sessions(a) {
  const limit = Math.min(Math.max(Number(a.limit) || 25, 1), 200);
  const want = (a.state || 'all').toLowerCase();
  const runOnly = want === 'running' || want === 'active';
  const wantState = want === 'stale' ? 'stale?' : want;
  const since = a.since_minutes ? Date.now() - a.since_minutes * 60000 : 0; // row filter
  // The list is newest first. For running-only, paging may stop once a page is older than the stale cutoff AND every id the
  // service reports as active has been seen (a job can be busy for hours with no new message, so its `updated` is old).
  const stopBefore = Math.max(since, runOnly ? Date.now() - STALE_MIN * 60000 : 0);
  const act = await activeIds();
  const unseen = new Set(act);
  const rows = [];
  let cursor, pages = 0, scanned = 0, partial = false;
  const deadline = Date.now() + SCAN_DEADLINE_MS;
  while (rows.length < limit && pages < 15) {
    if (pages > 0 && Date.now() > deadline) { partial = true; break; }
    const r = await api('GET', '/api/session', { limit: 100, search: a.search || a.title_prefix, cursor }); // title_prefix is narrowed server-side by substring, then checked as a prefix below
    const data = r.data ?? [];
    scanned += data.length;
    for (const s of data) {
      unseen.delete(s.id);
      const st = stateOf(s, act);
      const upd = s.time?.updated ?? s.time?.created ?? 0;
      if (runOnly) { if (st !== 'running') continue; }
      else if (want === 'finished') { if (['running', 'stale?'].includes(st)) continue; }
      else if (wantState !== 'all' && st !== wantState) continue;
      if (since && upd < since && !(runOnly && st === 'running')) continue;
      if (a.agent && s.agent !== a.agent) continue;
      if (a.directory && !String(s.location?.directory || '').includes(a.directory)) continue;
      if (a.title_prefix && !String(s.title || '').startsWith(a.title_prefix)) continue;
      if (a.children === false && s.parentID) continue;
      rows.push({ s, st, upd });
      if (rows.length >= limit) break;
    }
    if (stopBefore && data.length && (data[data.length - 1].time?.updated ?? 0) < stopBefore && (!unseen.size || a.search || a.title_prefix)) break; // with a server-side text filter, unmatched active ids can never show up
    cursor = r.cursor?.next;
    if (!cursor || !data.length) break;
    pages++;
  }
  const kept = rows;
  const head = `${kept.length} session(s) (state=${want}${a.agent ? `, agent=${a.agent}` : ''}${a.directory ? `, dir~${a.directory}` : ''}${a.title_prefix ? `, title^=${a.title_prefix}` : ''}${a.since_minutes ? `, last ${a.since_minutes}m` : ''}); scanned ${scanned}; service-active ids: ${act.size}${partial ? `; PARTIAL: time limit (${Math.round(SCAN_DEADLINE_MS / 1000)} s) reached after ${pages} page(s), narrow the filters` : ''}`;
  if (!kept.length) return head;
  return head + '\n' + kept.map(({ s, st, upd }) => `${s.id}  ${st.padEnd(11)} ${(s.agent || '-').padEnd(13)} ${ago(upd).padStart(5)} ago  ${(k(s.tokens?.input) + '/' + k(s.tokens?.output)).padStart(9)} tok  ${tail(s.location?.directory).padEnd(30)} ${s.parentID ? '↳ ' : ''}${clip(s.title, 90)}`).join('\n');
}

function renderMessage(m, toolChars, withTools = true) {
  const t = m.time?.created ? new Date(m.time.created).toLocaleTimeString('en-GB') : '';
  const out = [];
  if (m.type === 'idle') return [`[${t}] — idle${m.outcome ? ' (' + m.outcome + ')' : ''} —`, ...(m.error ? [`  ✖ error: ${clip(errText(m.error), 400)}`] : [])];
  if (m.type === 'agent-switched') return [`[${t}] agent → ${m.agent}`];
  if (typeof m.text === 'string' && !m.content) return [`[${t}] ${m.type}: ${clip(m.text, 1500)}`];
  if (m.error) out.push(`[${t}] ✖ error: ${clip(errText(m.error), 400)}`);
  if (m.finish === 'length') out.push(`[${t}] ⚠ output token limit hit in this step (finish=length)`);
  for (const b of m.content || []) {
    if (b.type === 'text' && b.text) out.push(`[${t}] ${m.type}: ${b.text.trim()}`);
    else if (b.type === 'tool' && withTools) {
      const st = b.state || {};
      const inp = typeof st.input === 'string' ? st.input : JSON.stringify(st.input ?? {});
      let res = st.content ?? st.error ?? st.output;
      if (Array.isArray(res)) res = res.map((x) => x?.text ?? '').join(' ');
      else if (res && typeof res === 'object') res = JSON.stringify(res);
      out.push(`  → ${b.name}(${clip(inp, toolChars)}) [${st.status}]${res ? ' ⇒ ' + clip(res, toolChars) : ''}`);
    }
  }
  return out;
}

async function sessionOutput(a) {
  const mode = (a.mode || 'tail').toLowerCase();
  const nmsg = Math.min(Math.max(Number(a.messages) || (mode === 'last' ? 20 : 12), 1), 200);
  const cap = Math.min(Math.max(Number(a.max_chars) || 6000, 500), 60000);
  const toolChars = Math.min(Math.max(Number(a.tool_chars) || 220, 40), 2000);
  const [sr, mr, act] = await Promise.all([api('GET', `/api/session/${encodeURIComponent(a.id)}`), api('GET', `/api/session/${encodeURIComponent(a.id)}/message`, { limit: nmsg }), activeIds()]);
  const s = sr.data ?? sr;
  const msgs = (mr.data ?? []).slice().reverse(); // API returns newest first
  const st = stateOf(s, act);
  const failRaw = (mr.data ?? []).map((m) => m.error).find(Boolean);
  const failure = failRaw ? (() => { const msg = errText(failRaw); const c = classify(msg); return `\nfailure: ${c.kind}: ${clip(msg, 300)}${c.advice ? '\nadvice: ' + c.advice : ''}`; })() : '';
  const why = st === 'interrupted' ? '\nnote: interrupted = stopped before it finished (its client or the opencode service was stopped or restarted, or someone interrupted it); this is not a provider failure and the work so far is below. A read-only run can be continued (opencode_resume on its bridge task, or a new task with this output); for an editing run check git status first.' : st === 'cancelled' ? '\nnote: cancelled through the bridge (opencode_cancel); the service records it as interrupted.' : '';
  const head = `${s.id}  ${st}  ${s.agent}  updated ${ago(s.time?.updated ?? s.time?.created ?? 0)} ago  ${k(s.tokens?.input)}/${k(s.tokens?.output)} tok\n${tail(s.location?.directory, 4)}  |  ${s.title}${failure}${why}`;
  let body;
  if (mode === 'last') {
    let last = '';
    for (const m of msgs.slice().reverse()) { if (m.type !== 'assistant') continue; const tx = (m.content || []).filter((b) => b.type === 'text' && b.text).map((b) => b.text.trim()).join('\n'); if (tx) { last = tx; break; } }
    body = last || `(no assistant text in the last ${msgs.length} messages; use mode=tail to see the tool calls)`;
  } else {
    body = msgs.flatMap((m) => renderMessage(m, toolChars, true)).join('\n') || '(no messages)';
  }
  if (body.length > cap) body = '…[cut]\n' + body.slice(-cap);
  return `${head}\n${'-'.repeat(40)}\n${body}`;
}

async function rename({ id, title }) {
  const clean = cleanTitle(title);
  if (!clean) throw new Error('title is empty');
  if (!String(id ?? '').trim()) throw new Error('id is required');
  await api('PATCH', `/api/session/${encodeURIComponent(id)}`, {}, { title: clean });
  const s = (await api('GET', `/api/session/${encodeURIComponent(id)}`)).data;
  const ok = /^[A-Za-z0-9._-]+\/[a-z-]+: .+/.test(s?.title || '');
  return `title is now: ${s?.title}${ok ? '' : '\nnote: does not match the convention "<LANE>/<agent>: <task>"'}`;
}

// Exact argv comes from /proc/<pid>/cmdline (NUL separated): `ps` joins arguments with spaces and loses the quoting, so a
// title with spaces could not be recovered from it.
function processes() {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-eo', 'pid,etime,comm', '--no-headers'], { maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(err);
      const rows = [];
      for (const line of out.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)/);
        if (!m || m[3] !== 'opencode') continue;
        const [, pid, et] = m;
        let argv, approx = false;
        if (PROCFS) { try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((x, i, a) => x !== '' || i < a.length - 1); } catch { continue; } }
        else { try { argv = execFileSync('ps', ['-o', 'args=', '-p', pid], { encoding: 'utf8' }).trim().split(' '); approx = true; } catch { continue; } } // no /proc (macOS ...): quoting is lost
        const rest = argv.slice(1);
        const flagWithValue = new Set(['-m', '--model', '--agent', '--title', '-s', '--session', '-f', '--file', '--format', '--server', '--log-level', '-w', '--worktree', '--prompt']);
        let sub = '', i = 0;
        for (; i < rest.length; i++) { if (flagWithValue.has(rest[i])) { i++; continue; } if (!rest[i].startsWith('-')) { sub = rest[i]; break; } }
        if (sub && sub !== 'run') continue; // serve / service / api / session / mcp ... are not work sessions
        if (rest.includes('--service') || rest.includes('--stdio')) continue;
        const val = (f) => { const j = rest.indexOf(f); return j >= 0 ? rest[j + 1] : undefined; };
        const agent = val('--agent') || '-';
        let title = val('--title') || '';
        if (approx && title) { const j = rest.indexOf('--title'); const stop = rest.findIndex((x, n) => n > j + 1 && x.startsWith('-')); title = rest.slice(j + 1, stop < 0 ? undefined : stop).join(' '); }
        const message = sub === 'run' ? rest.slice(i + 1).filter((x, j, a) => !x.startsWith('-') && !(a[j - 1] && flagWithValue.has(a[j - 1]))).join(' ') : '';
        let cwd = ''; if (PROCFS) { try { cwd = realpathSync(`/proc/${pid}/cwd`); } catch {} }
        rows.push(`${pid.padStart(8)}  ${et.padStart(10)}  ${(sub || 'TUI').padEnd(4)} ${agent.padEnd(13)} ${tail(cwd, 3).padEnd(34)} ${title || clip(message, 80) || '(interactive)'}`);
      }
      resolve(rows.length ? `pid        elapsed  kind agent         cwd                                title / task\n${rows.join('\n')}${PROCFS ? '' : '\n(no /proc on this system: titles with spaces and working directories are approximate or missing)'}` : 'no opencode run / TUI processes');
    });
  });
}

async function call(name, a, ctx = {}) {
  switch (name) {
    case 'opencode_start': { ensureState(); const r = start(a); const w = waitArg(a); if (!w) return r.text; const s = await waitTask(r.id, w, ctx); return live(s) ? `${r.text}\n${stillRunning(s, w)}` : `${r.text}\n${statusText(s)}\n${resultText(s, {})}`; }
    case 'opencode_policy': return policy(a);
    case 'opencode_status': { const w = waitArg(a); const s = await waitTask(String(a.id ?? ''), w, ctx); return statusText(s); }
    case 'opencode_result': { const w = waitArg(a); const s = await waitTask(String(a.id ?? ''), w, ctx); return w && live(s) ? stillRunning(s, w) : resultText(s, a); }
    case 'opencode_cancel': return cancel(a);
    case 'opencode_resume': return resume(a);
    case 'opencode_list': return listTasks(a);
    case 'opencode_sessions': return sessions(a);
    case 'opencode_session_output': return sessionOutput(a);
    case 'opencode_session_rename': return rename(a);
    case 'opencode_processes': return processes();
    default: throw new Error('unknown tool');
  }
}
function listTasks(a) {
  const want = String(a.state || '').toLowerCase(); const limit = num(a.limit, 50, 1, 500);
  const rows = registry().filter((t) => { try { return inside(t.cwd); } catch { return false; } }).filter((t) => !want || t.status === want).sort((x, y) => x.started - y.started).slice(-limit);
  return rows.map((t) => `${t.id} ${t.status}${t.failure ? ':' + t.failure.kind : ''} ${elapsed(t)}s${t.sessionID ? ' ' + t.sessionID : ''} ${t.agent}/${t.tier}/${t.mode} ${clip(t.title, 60)}${t.bridge?.pid !== process.pid ? ' [earlier bridge instance]' : ''}`).join('\n') || 'none';
}
// housekeeping at start-up: drop old finished task directories (and the attachments of tasks that died)
function pruneState() {
  const now = Date.now(); const fin = registry().filter((t) => isFinal(t.status)).sort((x, y) => (x.ended ?? x.started) - (y.ended ?? y.started));
  const drop = new Set(fin.filter((t) => now - (t.ended ?? t.started) > KEEP_DAYS * 86400000).map((t) => t.id)); for (const t of fin.slice(0, Math.max(0, fin.length - KEEP_FINISHED))) drop.add(t.id);
  for (const id of drop) { try { const a = readTask(id)?.attachDir; if (a) rmSync(a, { recursive: true, force: true }); rmSync(tdir(id), { recursive: true, force: true }); } catch {} }
  try { for (const f of readdirSync(CANCEL_DIR)) { try { if (now - Number(readFileSync(join(CANCEL_DIR, f), 'utf8')) > KEEP_DAYS * 86400000) rmSync(join(CANCEL_DIR, f)); } catch {} } } catch {}
}
// Safety net of the bridge: tasks whose supervisor (runner) is gone get their deadline enforced and their final state reconciled with the service.
async function supervise() { for (const t of registry()) { if (isFinal(t.status)) continue; if (pidAlive(t.runner)) continue; try { await snap(t.id); } catch {} } }

const capResponse = (t) => { t = String(t ?? ''); return t.length <= RESPONSE_CAP ? t : t.slice(0, Math.floor(RESPONSE_CAP * 0.6)) + `\n…[${t.length - RESPONSE_CAP} characters omitted to stay within the tool-output limit; narrow the request]…\n` + t.slice(-Math.floor(RESPONSE_CAP * 0.4)); };
// no tool call may block longer than the budget: a client-side tool timeout must never be the first to fire
const withBudget = (p, ms, name) => new Promise((resolve, reject) => { const h = setTimeout(() => { reject(new Error(`${name} did not finish within the bridge's ${Math.round(ms / 100) / 10} s budget (the opencode service or a lookup is slow). Nothing is lost: running tasks continue in the background; retry in a few seconds${/start|cancel|resume/.test(name) ? ' (check opencode_list first: the action may have been performed)' : ''}.`)); }, ms); h.unref?.(); p.then((v) => { clearTimeout(h); resolve(v); }, (e) => { clearTimeout(h); reject(e); }); });

// Run the stdio server only when started directly (`node server.mjs`); importing the file (rust/tools/dump_texts.mjs) just exposes the texts.
const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname); } catch { return false; } })();
export const __shared = { AGENT_RULE, tools, INSTRUCTIONS, MODE_RULES, TIER_RULE, VERIFY_RULE, ROSTER, KINDS, SECRET_RES, GUARD, GUARD_LANES, READ_ONLY, EDITORS, STALE_MIN };

if (isMain && process.argv[2] === '--runner') await runner(process.argv[3]); // detached supervisor of one task (never returns)
else if (isMain) {
// ---------- protocol loop, shutdown, last-resort guards ----------
const send = (m) => { try { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'); } catch {} };
let closing = false;
function shutdown(code = 0) {
  // The client went away (Claude Code exited or restarted) or we were told to stop. Tasks are DETACHED and keep running (their
  // state is on disk; the next bridge instance picks them up). Only OPENCODE_BRIDGE_KILL_ON_EXIT=1 restores the old behaviour.
  if (closing) return; closing = true;
  if (KILL_ON_EXIT) for (const t of registry()) { if (isFinal(t.status) || t.bridge?.pid !== process.pid) continue; try { writeFileSync(join(tdir(t.id), 'cancelled'), String(Date.now())); if (pidAlive(t.runner)) process.kill(t.runner.pid, 'SIGTERM'); } catch {} }
  setTimeout(() => process.exit(code), KILL_ON_EXIT ? 400 : 50);
}
const inflight = new Map(); // request id -> { aborted, progress }
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (!m || typeof m !== 'object') return;
  if (m.method === 'notifications/cancelled') { const c = inflight.get(m.params?.requestId); if (c) c.aborted = true; return; } // the client gave up on a call: stop waiting for it
  if (m.id === undefined || m.id === null) return; // notification or junk
  try {
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'opencode-bridge', version: VERSION }, instructions: INSTRUCTIONS } });
    else if (m.method === 'tools/list') send({ id: m.id, result: { tools } });
    else if (m.method === 'tools/call') {
      const args = m.params?.arguments; const name = String(m.params?.name ?? '');
      const ctx = { aborted: false, progress: null }; inflight.set(m.id, ctx);
      // keepalive: calls that carry a progressToken get MCP progress notifications while they run, so the client does not time them out
      const tok = m.params?._meta?.progressToken; let hb = null, n = 0, msg = 'working';
      if (tok !== undefined && tok !== null) { ctx.progress = (x) => { msg = x; }; hb = setInterval(() => send({ method: 'notifications/progress', params: { progressToken: tok, progress: ++n, message: String(msg).slice(0, 300) } }), PROGRESS_MS); }
      try { send({ id: m.id, result: { content: [{ type: 'text', text: capResponse(await withBudget(call(name, args && typeof args === 'object' && !Array.isArray(args) ? args : {}, ctx), CALL_BUDGET_MS, name)) }] } }); }
      catch (e) { send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: capResponse(e?.message ?? e) }] } }); }
      finally { if (hb) clearInterval(hb); inflight.delete(m.id); }
    } else send({ id: m.id, result: {} });
  } catch (e) { send({ id: m.id, error: { code: -32603, message: String(e?.message ?? e) } }); }
});
rl.on('close', () => shutdown(0));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(0));
process.stdout.on('error', (e) => { if (e?.code === 'EPIPE') shutdown(0); });
process.on('uncaughtException', (e) => { try { process.stderr.write(`opencode-bridge: uncaught ${e?.stack ?? e}\n`); } catch {} });
process.on('unhandledRejection', (e) => { try { process.stderr.write(`opencode-bridge: unhandled rejection ${e?.stack ?? e}\n`); } catch {} });
try { pruneState(); } catch {}
supervise().catch(() => {}); setInterval(() => supervise().catch(() => {}), 15000).unref();
}
