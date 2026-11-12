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
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { realpathSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';

const VERSION = '0.3.0';
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
  'NAMING: every session title is "<LANE>/<agent>: <task>" (e.g. ALPHA/deep-research: collect API notes); opencode_start sets it, opencode_session_rename fixes old ones. The agent roster (explorer, librarian, deep-research, oracle, fixer, designer, general) comes from the opencode-config repository (https://github.com/Subhajit-Roy-Partho/opencode-config); without it only the built-in "worker" agent exists.',
].join('\n\n');

const S = { type: 'string' }, N = { type: 'number' }, B = { type: 'boolean' };
const tools = [
  { name: 'opencode_start', description: 'Delegate an EASY or MEDIUM job to an opencode agent (async; returns a task id). POLICY IS ENFORCED: `tier` is required and hard/unsure work is refused (it stays on Claude); the routing MODE (blueprint default | sensitive | insensitive; sensitive wins) is detected from env OPENCODE_MODE, <project>/.claude/sensitive|insensitive, ~/.claude/insensitive, or the `mode` argument, and limits the agents (sensitive: explorer, librarian, deep-research, oracle, and fixer/worker only with mechanical:true). Blueprint mode: give fixer/designer a written Blueprint (files, signatures, edge cases, acceptance criteria, test command). Prompts containing secrets are refused. The session is titled "<LANE>/<agent>: <task>". Verify the result yourself - it is an untrusted draft. Call opencode_policy for the full rules.',
    inputSchema: { type: 'object', required: ['prompt', 'tier'], properties: {
      prompt: { ...S, description: 'Full task: context, absolute paths, desired output, test command; the agent has no memory of this conversation' },
      tier: { ...S, description: 'easy | medium (delegable) | hard | unsure (refused: stays on Claude)' },
      agent: { ...S, description: `opencode agent: ${Object.keys(ROSTER).join(' | ')} (default: explorer in sensitive mode, otherwise worker)` },
      mechanical: { ...B, description: 'sensitive mode only: true = strictly mechanical boilerplate / text replacement' },
      mode: { ...S, description: 'blueprint | sensitive | insensitive - only when the user asked for a mode; sensitive always wins over other sources' },
      cwd: { ...S, description: 'Directory inside the allowed root' },
      model: { ...S, description: `provider/model[#variant]; default ${DEFAULT_MODEL || "opencode's own default (set OPENCODE_BRIDGE_MODEL to change)"}` }, session: { ...S, description: 'Previous task id to continue its session' },
      lane: { ...S, description: 'Lane / project short name for the session title (capitals), default = cwd name' },
      title: { ...S, description: 'Full session title; overrides the generated "<lane>/<agent>: <task>" (keep the convention)' } } } },
  { name: 'opencode_policy', description: 'READ-ONLY. Show the delegation policy that opencode_start enforces: the ACTIVE routing mode for a directory and where it was detected, the agents allowed in that mode, the tier rules (what to delegate / keep), the verification rules and the roster. Call it before delegating if unsure which mode applies.',
    inputSchema: { type: 'object', properties: { cwd: { ...S, description: 'directory to evaluate (default: the bridge root)' }, mode: { ...S, description: 'preview what an explicit mode would do' } } } },
  { name: 'opencode_status', description: 'Status of a task started by this bridge (running/done/failed), elapsed time and session id.', inputSchema: { type: 'object', required: ['id'], properties: { id: S } } },
  { name: 'opencode_result', description: 'Final text output (or tail of it while running) of a task started by this bridge.', inputSchema: { type: 'object', required: ['id'], properties: { id: S, tail: N } } },
  { name: 'opencode_cancel', description: 'Kill a running task started by this bridge (never touches other sessions).', inputSchema: { type: 'object', required: ['id'], properties: { id: S } } },
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

// ---------- own tasks (v0.1) ----------
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function makeTitle({ lane, agent, prompt, cwd }) {
  const l = (lane || basename(cwd) || 'BRIDGE').toUpperCase().replace(/[^A-Z0-9._-]+/g, '-');
  const first = String(prompt).split('\n').map((x) => x.trim()).find((x) => x && !/^rules?:/i.test(x)) || 'task';
  return `${l}/${agent}: ${clip(first, 60)}`;
}

function start(a) {
  const { prompt, cwd = ROOT, model = DEFAULT_MODEL, session, lane, title, tier, mechanical, mode: explicitMode } = a;
  if (!inside(cwd)) throw new Error(`cwd must be inside ${ROOT}`);
  const det = detectMode(realpathSync(cwd), explicitMode);
  const agent = a.agent || (det.mode === 'sensitive' ? 'explorer' : process.env.OPENCODE_BRIDGE_AGENT || 'worker');
  checkDelegation({ agent, tier, mechanical, prompt: String(prompt ?? ''), mode: det.mode });
  const id = randomBytes(4).toString('hex');
  const prev = session && tasks.get(session);
  const args = ['run', '--standalone', '--agent', agent, '--auto', '--format', 'json', ...(model ? ['-m', model] : [])];
  const finalTitle = title || makeTitle({ lane, agent, prompt, cwd });
  if (prev?.sessionID) args.push('-s', prev.sessionID); // a continued session keeps its title
  else args.push('--title', finalTitle);
  args.push(`${guardFor(agent)}\n${AGENT_RULE(agent)}\n\n${prompt}`);
  const t = { id, status: 'running', started: Date.now(), text: '', sessionID: prev?.sessionID, err: '', mode: det.mode, agent, tier, title: finalTitle };
  const p = spawn('opencode', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PWD: cwd, OPENCODE_CONFIG_CONTENT: WORKER_CONFIG } }); // opencode resolves its project dir from $PWD, not the spawn cwd
  t.proc = p;
  createInterface({ input: p.stdout }).on('line', (l) => {
    try { const j = JSON.parse(l); t.sessionID ||= j.sessionID; if (j.type === 'text') t.text += j.part?.text ?? ''; } catch {}
  });
  p.stderr.on('data', (d) => { t.err = (t.err + d).slice(-4000); });
  p.on('error', (e) => { t.err += `spawn failed: ${e.message}`; t.status = 'failed'; t.ended = Date.now(); });
  p.on('close', (code) => { t.status = t.status === 'cancelled' ? 'cancelled' : code === 0 ? 'done' : 'failed'; t.ended = Date.now(); });
  tasks.set(id, t);
  const hint = det.mode === 'blueprint' && EDITORS.has(agent) ? ' Blueprint mode: make sure the prompt is a written Blueprint (files, signatures, acceptance criteria, test command).' : det.mode === 'insensitive' ? ' Insensitive mode: prefer parallel lanes (several tasks at once).' : '';
  return `task ${id} started | mode=${det.mode} (${det.source}) agent=${agent} tier=${tier} | title: ${finalTitle}\nNext: opencode_status / opencode_result (or opencode_session_output on the session id). ${VERIFY_RULE}${hint}`;
}

function policy({ cwd = ROOT, mode } = {}) {
  if (!inside(cwd)) throw new Error(`cwd must be inside ${ROOT}`);
  const det = detectMode(realpathSync(cwd), mode);
  const allowed = det.mode === 'sensitive' ? ['explorer', 'librarian', 'deep-research', 'oracle', 'fixer (mechanical:true only)', 'worker (mechanical:true only)'] : Object.keys(ROSTER);
  return [`ACTIVE MODE: ${det.mode.toUpperCase()}  (source: ${det.source}${det.all.length > 1 ? '; also seen: ' + det.all.map((f) => `${f.mode} via ${f.src}`).join(', ') : ''})`,
    `directory evaluated: ${realpathSync(cwd)}`, '', MODE_RULES[det.mode], '', `Agents allowed here: ${allowed.join(', ')}`, '', 'TIERS: ' + TIER_RULE, '', 'VERIFY: ' + VERIFY_RULE, '',
    'ROSTER:\n' + Object.entries(ROSTER).map(([k, v]) => `  ${k.padEnd(14)} ${v}`).join('\n'), '',
    'Detection order (SENSITIVE wins): env OPENCODE_BRIDGE_MODE / OPENCODE_MODE; <project>/.claude/sensitive; <project>/.claude/insensitive; ~/.claude/insensitive and $CLAUDE_CONFIG_DIR/insensitive; the `mode` argument when the user asked. Default: blueprint.',
    'Roster agents are defined in https://github.com/Subhajit-Roy-Partho/opencode-config (install it as ~/.config/opencode). Policy text: "OpenCode Specialist Delegation" in CLAUDE.md.'].join('\n');
}

const get = (id) => { const t = tasks.get(id); if (!t) throw new Error('unknown task (opencode_list shows this bridge\'s tasks; for any other session use opencode_sessions)'); return t; };
const el = (t) => Math.round(((t.ended ?? Date.now()) - t.started) / 1000);

// ---------- session visibility (v0.2) ----------
// All calls go through `opencode api`, which knows how to reach and authenticate to the background service.
function api(method, path, query = {}, body) {
  const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
  const args = ['api', method, q ? `${path}?${q}` : path];
  if (body !== undefined) args.push('-d', JSON.stringify(body));
  return new Promise((resolve, reject) => {
    execFile('opencode', args, { timeout: 45000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PWD: process.cwd() } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`opencode api ${method} ${path} failed: ${(stderr || err.message).trim().slice(0, 300)}`));
      const s = stdout.trim();
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch { reject(new Error(`opencode api ${method} ${path}: non-JSON reply: ${s.slice(0, 200)}`)); }
    });
  });
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
  let cursor, pages = 0, scanned = 0;
  while (rows.length < limit && pages < 15) {
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
  const head = `${kept.length} session(s) (state=${want}${a.agent ? `, agent=${a.agent}` : ''}${a.directory ? `, dir~${a.directory}` : ''}${a.title_prefix ? `, title^=${a.title_prefix}` : ''}${a.since_minutes ? `, last ${a.since_minutes}m` : ''}); scanned ${scanned}; service-active ids: ${act.size}`;
  if (!kept.length) return head;
  return head + '\n' + kept.map(({ s, st, upd }) => `${s.id}  ${st.padEnd(11)} ${(s.agent || '-').padEnd(13)} ${ago(upd).padStart(5)} ago  ${(k(s.tokens?.input) + '/' + k(s.tokens?.output)).padStart(9)} tok  ${tail(s.location?.directory).padEnd(30)} ${s.parentID ? '↳ ' : ''}${clip(s.title, 90)}`).join('\n');
}

function renderMessage(m, toolChars, withTools = true) {
  const t = m.time?.created ? new Date(m.time.created).toLocaleTimeString('en-GB') : '';
  const out = [];
  if (m.type === 'idle') return [`[${t}] — idle${m.outcome ? ' (' + m.outcome + ')' : ''} —`];
  if (m.type === 'agent-switched') return [`[${t}] agent → ${m.agent}`];
  if (typeof m.text === 'string' && !m.content) return [`[${t}] ${m.type}: ${clip(m.text, 1500)}`];
  for (const b of m.content || []) {
    if (b.type === 'text' && b.text) out.push(`[${t}] ${m.type}: ${b.text.trim()}`);
    else if (b.type === 'tool' && withTools) {
      const st = b.state || {};
      const inp = typeof st.input === 'string' ? st.input : JSON.stringify(st.input ?? {});
      let res = st.content;
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
  const head = `${s.id}  ${st}  ${s.agent}  updated ${ago(s.time?.updated ?? s.time?.created ?? 0)} ago  ${k(s.tokens?.input)}/${k(s.tokens?.output)} tok\n${tail(s.location?.directory, 4)}  |  ${s.title}`;
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
  if (!title || !String(title).trim()) throw new Error('title is empty');
  await api('PATCH', `/api/session/${encodeURIComponent(id)}`, {}, { title: String(title).trim() });
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
        let argv; try { argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((x, i, a) => x !== '' || i < a.length - 1); } catch { continue; }
        const rest = argv.slice(1);
        const flagWithValue = new Set(['-m', '--model', '--agent', '--title', '-s', '--session', '-f', '--file', '--format', '--server', '--log-level', '-w', '--worktree', '--prompt']);
        let sub = '', i = 0;
        for (; i < rest.length; i++) { if (flagWithValue.has(rest[i])) { i++; continue; } if (!rest[i].startsWith('-')) { sub = rest[i]; break; } }
        if (sub && sub !== 'run') continue; // serve / service / api / session / mcp ... are not work sessions
        if (rest.includes('--service') || rest.includes('--stdio')) continue;
        const val = (f) => { const j = rest.indexOf(f); return j >= 0 ? rest[j + 1] : undefined; };
        const agent = val('--agent') || '-', title = val('--title') || '';
        const message = sub === 'run' ? rest.slice(i + 1).filter((x, j, a) => !x.startsWith('-') && !(a[j - 1] && flagWithValue.has(a[j - 1]))).join(' ') : '';
        let cwd = ''; try { cwd = realpathSync(`/proc/${pid}/cwd`); } catch {}
        rows.push(`${pid.padStart(8)}  ${et.padStart(10)}  ${(sub || 'TUI').padEnd(4)} ${agent.padEnd(13)} ${tail(cwd, 3).padEnd(34)} ${title || clip(message, 80) || '(interactive)'}`);
      }
      resolve(rows.length ? `pid        elapsed  kind agent         cwd                                title / task\n${rows.join('\n')}` : 'no opencode run / TUI processes');
    });
  });
}

async function call(name, a) {
  switch (name) {
    case 'opencode_start': return start(a);
    case 'opencode_policy': return policy(a);
    case 'opencode_status': { const t = get(a.id); return `${t.status} (${el(t)}s, ${t.text.length} chars${t.sessionID ? ', session ' + t.sessionID : ''}) ${t.agent}/${t.tier}/${t.mode}`; }
    case 'opencode_result': { const t = get(a.id); const s = t.text || t.err || '(no output yet)'; return `[${t.status}]\n` + (a.tail ? s.slice(-a.tail) : s); }
    case 'opencode_cancel': { const t = get(a.id); t.status = 'cancelled'; t.proc.kill('SIGTERM'); return 'cancelled'; }
    case 'opencode_list': return [...tasks.values()].map((t) => `${t.id} ${t.status} ${el(t)}s${t.sessionID ? ' ' + t.sessionID : ''} ${t.agent}/${t.tier}/${t.mode} ${clip(t.title, 60)}`).join('\n') || 'none';
    case 'opencode_sessions': return sessions(a);
    case 'opencode_session_output': return sessionOutput(a);
    case 'opencode_session_rename': return rename(a);
    case 'opencode_processes': return processes();
    default: throw new Error('unknown tool');
  }
}

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
createInterface({ input: process.stdin }).on('line', async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return; // notification
  try {
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'opencode-bridge', version: VERSION }, instructions: INSTRUCTIONS } });
    else if (m.method === 'tools/list') send({ id: m.id, result: { tools } });
    else if (m.method === 'tools/call') {
      try { send({ id: m.id, result: { content: [{ type: 'text', text: String(await call(m.params.name, m.params.arguments ?? {})) }] } }); }
      catch (e) { send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: String(e.message) }] } }); }
    } else send({ id: m.id, result: {} });
  } catch (e) { send({ id: m.id, error: { code: -32603, message: String(e.message) } }); }
});
process.on('exit', () => tasks.forEach((t) => t.status === 'running' && t.proc.kill()));
