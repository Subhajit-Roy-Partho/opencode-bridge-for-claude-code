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
import { realpathSync, readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const VERSION = '0.4.0';
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
const tasks = new Map();
const STALE_MIN = 45; // a session with no outcome and no update for this long is reported as "stale?" (crashed / killed / hung)

// ---------- limits and robustness (v0.4) ----------
const num = (v, d, lo, hi) => { if (v === undefined || v === null || v === '') return d; const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };
const MAX_PARALLEL = num(process.env.OPENCODE_BRIDGE_MAX_PARALLEL, 6, 1, 64);            // concurrent delegated tasks
const DEFAULT_TIMEOUT_MIN = num(process.env.OPENCODE_BRIDGE_TIMEOUT_MIN, 120, 1, 1440);  // per-task wall clock
const MAX_RETRIES = num(process.env.OPENCODE_BRIDGE_RETRIES, 2, 0, 5);                   // automatic retries: read-only agents, transient errors only
const RETRY_DELAY_MS = num(process.env.OPENCODE_BRIDGE_RETRY_DELAY_S, 20, 0, 600) * 1000; // first delay; x3 for the next
const API_TIMEOUT_MS = num(process.env.OPENCODE_BRIDGE_API_TIMEOUT_MS, 45000, 200, 600000);
const SCAN_DEADLINE_MS = num(process.env.OPENCODE_BRIDGE_SCAN_DEADLINE_MS, 35000, 200, 600000);
const KILL_GRACE_MS = num(process.env.OPENCODE_BRIDGE_KILL_GRACE_MS, 5000, 50, 60000);   // SIGTERM -> SIGKILL
const MAX_TEXT = 2_000_000;      // output kept per task (the last 2 MB)
const ARG_LIMIT = 100_000;       // bytes; Linux allows ~128 KiB per single argument, larger prompts are attached as a file
const PROMPT_MAX = 5_000_000;
const RESULT_CAP = 60_000;       // default size of opencode_result (Claude Code limits MCP tool output)
const RESPONSE_CAP = 100_000;    // hard cap of any tool reply
const PROCFS = process.env.OPENCODE_BRIDGE_PROCFS !== '0' && existsSync('/proc/self/cmdline'); // OPENCODE_BRIDGE_PROCFS=0 forces the ps fallback (tests)
const TIMEOUT_UNIT_MS = num(process.env.OPENCODE_BRIDGE_TIMEOUT_UNIT_MS, 60000, 10, 60000); // one "minute" of timeout_minutes (tests shorten it)
const KEEP_FINISHED = 200;       // finished tasks kept in memory

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
  'WORKFLOW: opencode_start needs tier (easy|medium) and agent (' + Object.keys(ROSTER).join('|') + '); then poll opencode_status / opencode_result; see all sessions with opencode_sessions (state=running for what is active now) and read one with opencode_session_output. ' + VERIFY_RULE,
  'LIMITS AND ERRORS: at most OPENCODE_BRIDGE_MAX_PARALLEL tasks run at once (default 6) and each has a timeout (default 120 min, process group killed). Failures are classified in opencode_result (rate_limit, quota, context_length, output_limit, overloaded, auth, model, agent, invalid_request, network, timeout, spawn, exit) with advice. Only TRANSIENT errors (rate_limit, overloaded, network) of READ-ONLY agents that produced no output are retried automatically with backoff; an editing agent is never replayed. quota / auth / context_length / invalid_request are not retried: switch model, split the task, or keep the work on Claude. Prompts over ~100 KB are attached as a file.',
  'NAMING: every session title is "<LANE>/<agent>: <task>" (e.g. ALPHA/deep-research: collect API notes); opencode_start sets it, opencode_session_rename fixes old ones. The agent roster (explorer, librarian, deep-research, oracle, fixer, designer, general) comes from the opencode-config repository (https://github.com/Subhajit-Roy-Partho/opencode-config); without it only the built-in "worker" agent exists.',
].join('\n\n');

const S = { type: 'string' }, N = { type: 'number' }, B = { type: 'boolean' };
const tools = [
  { name: 'opencode_start', description: 'Delegate an EASY or MEDIUM job to an opencode agent (async; returns a task id). POLICY IS ENFORCED: `tier` is required and hard/unsure work is refused (it stays on Claude); the routing MODE (blueprint default | sensitive | insensitive; sensitive wins) is detected from env OPENCODE_MODE, <project>/.claude/sensitive|insensitive, ~/.claude/insensitive, or the `mode` argument, and limits the agents (sensitive: explorer, librarian, deep-research, oracle, and fixer/worker only with mechanical:true). Blueprint mode: give fixer/designer a written Blueprint (files, signatures, edge cases, acceptance criteria, test command). Prompts containing secrets are refused. The session is titled "<LANE>/<agent>: <task>". LIMITS: at most OPENCODE_BRIDGE_MAX_PARALLEL tasks at once (default 6), a per-task timeout, automatic retry (backoff) of transient provider errors for read-only agents only, prompts over ~100 KB are sent as an attached file. Verify the result yourself - it is an untrusted draft. Call opencode_policy for the full rules.',
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
      timeout_minutes: { ...N, description: `wall-clock limit, default ${DEFAULT_TIMEOUT_MIN} (1-1440); the process group is killed when it is reached` } } } },
  { name: 'opencode_policy', description: 'READ-ONLY. Show the delegation policy that opencode_start enforces: the ACTIVE routing mode for a directory and where it was detected, the agents allowed in that mode, the tier rules (what to delegate / keep), the verification rules and the roster. Call it before delegating if unsure which mode applies.',
    inputSchema: { type: 'object', properties: { cwd: { ...S, description: 'directory to evaluate (default: the bridge root)' }, mode: { ...S, description: 'preview what an explicit mode would do' } } } },
  { name: 'opencode_status', description: 'Status of a task started by this bridge (running/done/failed), elapsed time and session id.', inputSchema: { type: 'object', required: ['id'], properties: { id: S } } },
  { name: 'opencode_result', description: 'Output of a task started by this bridge, with the failure kind and advice when it failed (rate_limit, quota, context_length, output_limit, overloaded, auth, model, agent, invalid_request, network, timeout, spawn, exit). Large outputs are cut to the last 60000 characters unless `head` / `tail` is given.', inputSchema: { type: 'object', required: ['id'], properties: { id: S, tail: { ...N, description: 'only the last N characters' }, head: { ...N, description: 'only the first N characters' } } } },
  { name: 'opencode_cancel', description: 'Cancel a running or retrying task started by this bridge: SIGTERM, then SIGKILL, to its whole process group (never touches other sessions). A finished task is reported as such.', inputSchema: { type: 'object', required: ['id'], properties: { id: S } } },
  { name: 'opencode_list', description: 'List tasks started by this bridge. For ALL opencode sessions use opencode_sessions.', inputSchema: { type: 'object', properties: {} } },
  { name: 'opencode_sessions', description: 'READ-ONLY. List opencode sessions of the background service across all projects (newest first): id, state (running / succeeded / failed / interrupted / stale?), agent, age, tokens, directory, title. Use state=running to see what is active now; a session whose last update is older than ~45 min and has no outcome is shown as "stale?".',
    inputSchema: { type: 'object', properties: {
      state: { ...S, description: 'running (default: all) | active | finished | succeeded | failed | interrupted | stale | all' },
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

// ---------- own tasks ----------
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const cleanTitle = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
function makeTitle({ lane, agent, prompt, cwd }) {
  const l = (lane || basename(cwd) || 'BRIDGE').toUpperCase().replace(/[^A-Z0-9._-]+/g, '-');
  const first = String(prompt).split('\n').map((x) => x.trim()).find((x) => x && !/^rules?:/i.test(x)) || 'task';
  return cleanTitle(`${l}/${agent}: ${clip(first, 60)}`);
}

const live = (t) => t.status === 'running' || t.status === 'retrying';
const runningTasks = () => [...tasks.values()].filter(live);
function killGroup(t, sig) { // the whole process group: opencode's own children (shell tools) must not outlive it
  const p = t.proc; if (!p?.pid || p.exitCode !== null || p.signalCode !== null) return;
  try { process.kill(-p.pid, sig); } catch { try { p.kill(sig); } catch {} }
}
function cleanupTmp(t) { if (t.tmpdir) { try { rmSync(t.tmpdir, { recursive: true, force: true }); } catch {} t.tmpdir = null; } }
function clearTimers(t) { for (const k of ['timeoutTimer', 'killTimer', 'retryTimer']) if (t[k]) { clearTimeout(t[k]); t[k] = null; } }
function prune() { const fin = [...tasks.values()].filter((t) => t.ended).sort((a, b) => a.ended - b.ended); for (const t of fin.slice(0, Math.max(0, fin.length - KEEP_FINISHED))) tasks.delete(t.id); }
function spawnFailure(e) {
  if (e?.code === 'ENOENT') return { kind: 'spawn', message: 'the opencode binary was not found on PATH', advice: 'Install opencode (>= 2) and make sure the process that runs the bridge has it on PATH.', transient: false };
  if (e?.code === 'E2BIG') return { kind: 'spawn', message: 'argument list too long', advice: 'The prompt did not fit on the command line (it is normally attached as a file automatically).', transient: false };
  return { kind: 'spawn', message: clip(e?.message ?? e, 300), advice: '', transient: false };
}

function launch(t) {
  t.attempts++; t.text = ''; t.textTruncated = false; t.errors = []; t.err = ''; t.exitCode = null; t.timedOut = false; t.failure = null; t.sessionID = t.resume;
  let p;
  try { p = spawn('opencode', t.args, { cwd: t.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PWD: t.cwd, OPENCODE_CONFIG_CONTENT: WORKER_CONFIG } }); } // opencode resolves its project dir from $PWD, not the spawn cwd
  catch (e) { return finalize(t, null, null, e); }
  t.proc = p;
  createInterface({ input: p.stdout }).on('line', (l) => {
    let j; try { j = JSON.parse(l); } catch { return; }
    if (!j || typeof j !== 'object') return;
    t.sessionID ||= j.sessionID;
    if (j.type === 'text') { t.text += j.part?.text ?? ''; if (t.text.length > MAX_TEXT) { t.text = t.text.slice(-MAX_TEXT); t.textTruncated = true; } }
    else if (j.type === 'error' && t.errors.length < 20) t.errors.push(errText(j.error ?? j.message ?? j));
  });
  p.stderr.on('data', (d) => { t.err = (t.err + d).slice(-4000); });
  p.on('error', (e) => finalize(t, null, null, e, p));
  p.on('close', (code, sig) => finalize(t, code, sig, null, p));
  // a grandchild (a background process the agent started) can keep the pipes open after opencode itself has exited
  p.on('exit', (code, sig) => { const h = setTimeout(() => finalize(t, code, sig, null, p), 2000); h.unref?.(); });
  t.timeoutTimer = setTimeout(() => { t.timedOut = true; killGroup(t, 'SIGTERM'); t.killTimer = setTimeout(() => killGroup(t, 'SIGKILL'), KILL_GRACE_MS); }, t.timeoutMs);
}

function finalize(t, code, sig, spawnErr, p) {
  if (p) { if (t.finalizedProc === p) return; t.finalizedProc = p; }
  if (t.proc !== p && p) return; // a stale process of an earlier attempt
  clearTimers(t);
  if (t.status === 'cancelled') { cleanupTmp(t); t.ended ??= Date.now(); return; }
  t.exitCode = code;
  let failure = null;
  if (spawnErr) failure = spawnFailure(spawnErr);
  else if (t.timedOut) failure = { kind: 'timeout', message: `no result after ${t.timeoutMs >= 60000 ? Math.round(t.timeoutMs / 60000) + ' min' : t.timeoutMs + ' ms'}; the process group was killed`, advice: 'Split the task into smaller pieces or raise timeout_minutes / OPENCODE_BRIDGE_TIMEOUT_MIN. Any partial output is in opencode_result.', transient: false };
  else if (code !== 0 || (t.errors.length && !t.text)) {
    const msg = t.errors[0] || t.err.trim().split('\n').filter(Boolean).slice(-1)[0] || (sig ? `killed by signal ${sig}` : `exit code ${code}`);
    const c = classify(`${t.errors.join(' ')} ${t.err}`);
    failure = { kind: c.kind === 'other' ? (sig ? 'signal' : 'exit') : c.kind, message: clip(msg, 400), advice: c.advice, transient: c.transient };
  }
  if (!failure) { t.status = 'done'; t.ended = Date.now(); cleanupTmp(t); return; }
  t.failure = failure;
  // Retry only what is safe to replay: transient provider/network errors of READ-ONLY agents that produced no output yet.
  if (failure.transient && READ_ONLY.has(t.agent) && !t.text && t.attempts <= MAX_RETRIES) {
    const delay = RETRY_DELAY_MS * 3 ** (t.attempts - 1);
    t.status = 'retrying'; t.retryAt = Date.now() + delay;
    t.retryTimer = setTimeout(() => { t.retryTimer = null; t.status = 'running'; launch(t); }, delay);
    return;
  }
  t.status = failure.kind === 'timeout' ? 'timeout' : 'failed'; t.ended = Date.now(); cleanupTmp(t);
}

function start(a) {
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
  checkDelegation({ agent, tier, mechanical: a.mechanical === true || a.mechanical === 'true', prompt, mode: det.mode });
  const sessionArg = str(a.session)?.trim(); let prev;
  if (sessionArg) {
    prev = tasks.get(sessionArg);
    if (!prev) throw new Error(`session continuation: unknown task id "${sessionArg}" (opencode_list shows this bridge's tasks)`);
    if (!prev.sessionID) throw new Error('session continuation: that task has no session id yet (still starting, or it failed before a session was created)');
  }
  const running = runningTasks();
  if (running.length >= MAX_PARALLEL) throw new Error(`parallel limit reached (${running.length}/${MAX_PARALLEL} tasks running or waiting to retry): ${running.map((r) => `${r.id} ${r.agent} "${clip(r.title, 40)}"`).join('; ')}. Wait for one to finish (opencode_status), cancel one (opencode_cancel), or raise OPENCODE_BRIDGE_MAX_PARALLEL.`);
  const id = randomBytes(4).toString('hex');
  const finalTitle = cleanTitle(a.title) || makeTitle({ lane: str(a.lane), agent, prompt, cwd });
  const args = ['run', '--standalone', '--agent', agent, '--auto', '--format', 'json', ...(model ? ['-m', model] : [])];
  if (prev?.sessionID) args.push('-s', prev.sessionID); // a continued session keeps its title
  else args.push('--title', finalTitle);
  const full = `${guardFor(agent)}\n${AGENT_RULE(agent)}\n\n${prompt}`;
  let message = full, tmp = null;
  if (Buffer.byteLength(full) > ARG_LIMIT) { // one argv entry is limited to ~128 KiB on Linux: attach the task as a file instead
    tmp = mkdtempSync(join(tmpdir(), 'ocb-')); const f = join(tmp, 'task.md'); writeFileSync(f, full, { mode: 0o600 });
    args.push('-f', f); message = `${guardFor(agent)}\n${AGENT_RULE(agent)}\n\nThe complete task is in the attached file task.md. Read it first and follow it exactly.`;
  }
  args.push(message);
  const timeoutMin = num(a.timeout_minutes, DEFAULT_TIMEOUT_MIN, 1, 1440), timeoutMs = timeoutMin * TIMEOUT_UNIT_MS;
  const t = { id, status: 'running', started: Date.now(), text: '', errors: [], err: '', attempts: 0, timeoutMin, resume: prev?.sessionID, mode: det.mode, agent, tier, title: finalTitle, args, cwd, tmpdir: tmp, timeoutMs, failure: null };
  tasks.set(id, t); prune();
  launch(t);
  const hint = det.mode === 'blueprint' && EDITORS.has(agent) ? ' Blueprint mode: make sure the prompt is a written Blueprint (files, signatures, acceptance criteria, test command).' : det.mode === 'insensitive' ? ' Insensitive mode: prefer parallel lanes (several tasks at once).' : '';
  const lim = `Limits: ${runningTasks().length}/${MAX_PARALLEL} parallel, timeout ${timeoutMin} min${READ_ONLY.has(agent) ? `, up to ${MAX_RETRIES} automatic retries of transient provider errors` : ', no automatic retry (editing agent)'}${tmp ? `, prompt ${Math.round(Buffer.byteLength(full) / 1024)} KB sent as an attached file` : ''}.`;
  return `task ${id} started | mode=${det.mode} (${det.source}) agent=${agent} tier=${tier} | title: ${finalTitle}\nNext: opencode_status / opencode_result (or opencode_session_output on the session id). ${lim} ${VERIFY_RULE}${hint}`;
}

function cancel(t) {
  if (!live(t)) return `task already ${t.status}; nothing to cancel`;
  const wasRetrying = t.status === 'retrying';
  clearTimers(t); t.status = 'cancelled'; t.ended = Date.now();
  if (!wasRetrying) { killGroup(t, 'SIGTERM'); t.killTimer = setTimeout(() => killGroup(t, 'SIGKILL'), KILL_GRACE_MS); } else cleanupTmp(t);
  return 'cancelled';
}

function policy({ cwd = ROOT, mode } = {}) {
  if (!inside(cwd)) throw new Error(`cwd must be inside ${ROOT}`);
  const det = detectMode(realpathSync(cwd), mode);
  const allowed = det.mode === 'sensitive' ? ['explorer', 'librarian', 'deep-research', 'oracle', 'fixer (mechanical:true only)', 'worker (mechanical:true only)'] : Object.keys(ROSTER);
  return [`ACTIVE MODE: ${det.mode.toUpperCase()}  (source: ${det.source}${det.all.length > 1 ? '; also seen: ' + det.all.map((f) => `${f.mode} via ${f.src}`).join(', ') : ''})`,
    `directory evaluated: ${realpathSync(cwd)}`, '', MODE_RULES[det.mode], '', `Agents allowed here: ${allowed.join(', ')}`, '', 'TIERS: ' + TIER_RULE, '', 'VERIFY: ' + VERIFY_RULE, '',
    'ROSTER:\n' + Object.entries(ROSTER).map(([k, v]) => `  ${k.padEnd(14)} ${v}`).join('\n'), '',
    `LIMITS: ${MAX_PARALLEL} parallel tasks, timeout ${DEFAULT_TIMEOUT_MIN} min, ${MAX_RETRIES} automatic retries (read-only agents, transient errors only), tool output capped at ${RESPONSE_CAP} characters. Error kinds and advice: see opencode_result.`, '',
    'Detection order (SENSITIVE wins): env OPENCODE_BRIDGE_MODE / OPENCODE_MODE; <project>/.claude/sensitive; <project>/.claude/insensitive; ~/.claude/insensitive and $CLAUDE_CONFIG_DIR/insensitive; the `mode` argument when the user asked. Default: blueprint.',
    'Roster agents are defined in https://github.com/Subhajit-Roy-Partho/opencode-config (install it as ~/.config/opencode). Policy text: "OpenCode Specialist Delegation" in CLAUDE.md.'].join('\n');
}

const get = (id) => { const t = tasks.get(String(id ?? '')); if (!t) throw new Error('unknown task (opencode_list shows this bridge\'s tasks; for any other session use opencode_sessions)'); return t; };
const el = (t) => Math.round(((t.ended ?? Date.now()) - t.started) / 1000);
const statusText = (t) => `${t.status}${t.failure ? ` (${t.failure.kind})` : ''}${t.status === 'retrying' ? ` in ${Math.max(0, Math.round((t.retryAt - Date.now()) / 1000))}s` : ''} (${el(t)}s, ${t.text.length} chars${t.sessionID ? ', session ' + t.sessionID : ''}${t.attempts > 1 ? `, attempt ${t.attempts}` : ''}) ${t.agent}/${t.tier}/${t.mode}${t.status === 'done' && t.errors.length ? ` [${t.errors.length} error event(s) during the run]` : ''}`;
function resultText(t, a) {
  const lines = [`[${t.status}${t.failure ? ': ' + t.failure.kind : ''}]`];
  if (t.failure) { lines.push(t.failure.message); if (t.failure.advice) lines.push('Advice: ' + t.failure.advice); }
  if (t.status === 'retrying') lines.push(`waiting ${Math.max(0, Math.round((t.retryAt - Date.now()) / 1000))}s before attempt ${t.attempts + 1} of ${MAX_RETRIES + 1}`);
  if (!t.failure && t.errors.length) lines.push(`warning: ${t.errors.length} error event(s) during the run, first: ${clip(t.errors[0], 200)}`);
  if (t.textTruncated) lines.push(`note: the output exceeded ${MAX_TEXT / 1e6} MB; only the last ${MAX_TEXT / 1e6} MB are kept`);
  let body = t.text || (t.failure || t.status === 'cancelled' ? '' : '(no output yet)');
  const tailN = num(a.tail, 0, 0, 5e7), headN = num(a.head, 0, 0, 5e7);
  if (tailN && body.length > tailN) body = body.slice(-tailN); else if (headN && body.length > headN) body = body.slice(0, headN);
  else if (!tailN && !headN && body.length > RESULT_CAP) { lines.push(`note: ${body.length - RESULT_CAP} earlier characters omitted (output is ${body.length}); pass head=N for the beginning or tail=N for a different size`); body = body.slice(-RESULT_CAP); }
  if (t.failure && body) lines.push('--- partial output ---');
  return lines.join('\n') + (body ? '\n' + body : '');
}

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
  if (s.outcome) return s.outcome;
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
  const head = `${s.id}  ${st}  ${s.agent}  updated ${ago(s.time?.updated ?? s.time?.created ?? 0)} ago  ${k(s.tokens?.input)}/${k(s.tokens?.output)} tok\n${tail(s.location?.directory, 4)}  |  ${s.title}${failure}`;
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

const capResponse = (t) => { t = String(t ?? ''); return t.length <= RESPONSE_CAP ? t : t.slice(0, Math.floor(RESPONSE_CAP * 0.6)) + `\n…[${t.length - RESPONSE_CAP} characters omitted to stay within the tool-output limit; narrow the request]…\n` + t.slice(-Math.floor(RESPONSE_CAP * 0.4)); };
async function call(name, a) {
  switch (name) {
    case 'opencode_start': return start(a);
    case 'opencode_policy': return policy(a);
    case 'opencode_status': return statusText(get(a.id));
    case 'opencode_result': return resultText(get(a.id), a);
    case 'opencode_cancel': return cancel(get(a.id));
    case 'opencode_list': return [...tasks.values()].map((t) => `${t.id} ${t.status}${t.failure ? ':' + t.failure.kind : ''} ${el(t)}s${t.sessionID ? ' ' + t.sessionID : ''} ${t.agent}/${t.tier}/${t.mode} ${clip(t.title, 60)}`).join('\n') || 'none';
    case 'opencode_sessions': return sessions(a);
    case 'opencode_session_output': return sessionOutput(a);
    case 'opencode_session_rename': return rename(a);
    case 'opencode_processes': return processes();
    default: throw new Error('unknown tool');
  }
}

// ---------- protocol loop, shutdown, last-resort guards ----------
const send = (m) => { try { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'); } catch {} };
let closing = false;
function shutdown(code = 0) { // the client went away (or we were told to stop): no orphaned opencode processes or temp files
  if (closing) return; closing = true;
  for (const t of tasks.values()) { clearTimers(t); if (live(t)) killGroup(t, 'SIGTERM'); }
  setTimeout(() => { for (const t of tasks.values()) { killGroup(t, 'SIGKILL'); cleanupTmp(t); } process.exit(code); }, 300);
}
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (!m || typeof m !== 'object' || m.id === undefined || m.id === null) return; // notification or junk
  try {
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'opencode-bridge', version: VERSION }, instructions: INSTRUCTIONS } });
    else if (m.method === 'tools/list') send({ id: m.id, result: { tools } });
    else if (m.method === 'tools/call') {
      const args = m.params?.arguments;
      try { send({ id: m.id, result: { content: [{ type: 'text', text: capResponse(await call(String(m.params?.name ?? ''), args && typeof args === 'object' && !Array.isArray(args) ? args : {})) }] } }); }
      catch (e) { send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: capResponse(e?.message ?? e) }] } }); }
    } else send({ id: m.id, result: {} });
  } catch (e) { send({ id: m.id, error: { code: -32603, message: String(e?.message ?? e) } }); }
});
rl.on('close', () => shutdown(0));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(0));
process.stdout.on('error', (e) => { if (e?.code === 'EPIPE') shutdown(0); });
process.on('uncaughtException', (e) => { try { process.stderr.write(`opencode-bridge: uncaught ${e?.stack ?? e}\n`); } catch {} });
process.on('unhandledRejection', (e) => { try { process.stderr.write(`opencode-bridge: unhandled rejection ${e?.stack ?? e}\n`); } catch {} });
process.on('exit', () => tasks.forEach((t) => { if (live(t)) killGroup(t, 'SIGKILL'); cleanupTmp(t); }));
