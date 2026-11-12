// Offline test suite (no network, no real opencode): node --test test/
// Runs server.mjs over stdio against the fake opencode in test/bin and a compiled process stub.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { startServer, tmp, readLog, waitFor, buildStub, sleep } from './helpers.mjs';

const lines = (s) => s.split('\n');
const idsIn = (s) => [...s.matchAll(/^(ses_\d{3})\s/gm)].map((m) => m[1]);

// ---------------------------------------------------------------- protocol
describe('MCP protocol', () => {
  let s; before(() => { s = startServer(); }); after(() => s.close());

  test('initialize reports name and version, echoes the protocol version', async () => {
    const r = await s.rpc('initialize', { protocolVersion: '2025-03-26' });
    assert.equal(r.result.serverInfo.name, 'opencode-bridge');
    assert.match(r.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
    assert.equal(r.result.protocolVersion, '2025-03-26');
    assert.deepEqual(Object.keys(r.result.capabilities), ['tools']);
  });
  test('initialize without a protocolVersion falls back to a default', async () => {
    assert.equal((await s.rpc('initialize', {})).result.protocolVersion, '2024-11-05');
  });
  test('tools/list: the ten tools, each with a valid object schema', async () => {
    const { tools } = (await s.rpc('tools/list')).result;
    assert.deepEqual(tools.map((t) => t.name).sort(), ['opencode_cancel', 'opencode_list', 'opencode_policy', 'opencode_processes', 'opencode_result', 'opencode_session_output', 'opencode_session_rename', 'opencode_sessions', 'opencode_start', 'opencode_status']);
    for (const t of tools) {
      assert.ok(t.description.length > 20, `${t.name} description`);
      assert.equal(t.inputSchema.type, 'object');
      for (const req of t.inputSchema.required ?? []) assert.ok(req in t.inputSchema.properties, `${t.name}: required ${req} is declared`);
      for (const [k, v] of Object.entries(t.inputSchema.properties ?? {})) assert.ok(['string', 'number', 'boolean'].includes(v.type), `${t.name}.${k} type`);
    }
  });
  test('read-only tools say so in their description', async () => {
    const { tools } = (await s.rpc('tools/list')).result;
    for (const n of ['opencode_sessions', 'opencode_session_output', 'opencode_processes']) assert.match(tools.find((t) => t.name === n).description, /READ-ONLY/);
  });
  test('unknown method gets an empty result, not a crash', async () => { assert.deepEqual((await s.rpc('ping')).result, {}); });
  test('notifications get no reply and do not break the stream', async () => {
    const before = s.extra.length; s.notify('notifications/initialized'); s.notify('anything');
    assert.deepEqual((await s.rpc('ping')).result, {}); assert.equal(s.extra.length, before);
  });
  test('invalid JSON lines are ignored', async () => { s.raw('{not json\n'); s.raw('\n'); assert.deepEqual((await s.rpc('ping')).result, {}); });
  test('unknown tool is an isError result with a message', async () => {
    const r = await s.call('opencode_nope'); assert.equal(r.isError, true); assert.match(r.content[0].text, /unknown tool/);
  });
  test('missing arguments object is tolerated', async () => {
    const r = (await s.rpc('tools/call', { name: 'opencode_list' })).result; assert.equal(r.content[0].text, 'none');
  });
  test('process stays quiet on stderr', () => { assert.equal(s.stderr, ''); });
});

// ---------------------------------------------------------------- own tasks (opencode_start & co)
describe('own tasks: start / status / result / cancel / list', () => {
  const log = join(tmp(), 'log'); let s;
  before(() => { s = startServer({ env: { FAKE_LOG: log } }); }); after(() => s.close());
  const startArgv = async (args, env) => { const id = (await s.text('opencode_start', { tier: 'easy', ...args })).match(/task (\w+) started/)[1]; await waitFor(async () => /done|failed/.test(await s.text('opencode_status', { id })) , 8000); return id; };
  const lastRun = () => readLog(log).filter((l) => l.argv[0] === 'run').at(-1);

  test('start runs `opencode run` with standalone worker flags, json format, model, guard text', async () => {
    const id = await startArgv({ prompt: 'Summarise the repo\nsecond line' });
    const r = lastRun().argv;
    assert.deepEqual(r.slice(0, 2), ['run', '--standalone']);
    assert.equal(r[r.indexOf('--agent') + 1], 'worker'); assert.ok(r.includes('--auto'));
    assert.equal(r[r.indexOf('--format') + 1], 'json'); assert.ok(!r.includes('-m'), 'no -m flag without OPENCODE_BRIDGE_MODEL'); assert.ok(!r.includes('opencode-go'));
    assert.match(r.at(-1), /^Rules: do the work yourself/); assert.match(r.at(-1), /Summarise the repo/);
    assert.equal(lastRun().config, 'set'); // worker agent config injected
    assert.match(await s.text('opencode_result', { id }), /^\[done\]\nhello world$/);
  });
  test('default title is "<CWD-NAME>/<agent>: <first line>"', async () => {
    await startArgv({ prompt: 'Summarise the repo\nsecond line' });
    const r = lastRun().argv; const title = r[r.indexOf('--title') + 1];
    assert.match(title, /^[A-Z0-9._-]+\/worker: Summarise the repo$/);
  });
  test('lane is upper-cased and sanitised; long first line is clipped', async () => {
    await startArgv({ prompt: 'x'.repeat(200), lane: 'docs sync!' });
    const t = lastRun().argv; const title = t[t.indexOf('--title') + 1];
    assert.match(title, /^DOCS-SYNC-\/worker: x{59}…$/);
  });
  test('explicit title wins', async () => {
    await startArgv({ prompt: 'p', title: 'MY/fixer: exactly this' });
    const t = lastRun().argv; assert.equal(t[t.indexOf('--title') + 1], 'MY/fixer: exactly this');
  });
  test('GUARD line in the prompt is skipped when picking the title line', async () => {
    await startArgv({ prompt: 'Rules: be nice\nReal task here', lane: 'a' });
    const t = lastRun().argv; assert.match(t[t.indexOf('--title') + 1], /Real task here$/);
  });
  test('continuing a task reuses its session id and sets no new title', async () => {
    const a = await startArgv({ prompt: 'first' });
    const n = readLog(log).filter((l) => l.argv[0] === 'run').length;
    await s.text('opencode_start', { tier: 'easy', prompt: 'second', session: a }); await waitFor(() => readLog(log).filter((l) => l.argv[0] === 'run').length > n);
    const r = lastRun().argv; assert.equal(r[r.indexOf('-s') + 1], 'ses_fake01'); assert.ok(!r.includes('--title'));
  });
  test('cwd outside the root is refused', async () => {
    const r = await s.call('opencode_start', { tier: 'easy', prompt: 'x', cwd: '/tmp' }); assert.equal(r.isError, true); assert.match(r.content[0].text, /cwd must be inside/);
  });
  test('cwd inside the root is accepted and used as the working directory and $PWD', async () => {
    const sub = join(s.rootDir, 'sub'); (await import('node:fs')).mkdirSync(sub);
    await startArgv({ prompt: 'p', cwd: sub });
    const l = lastRun(); assert.equal(l.cwd, (await import('node:fs')).realpathSync(sub)); assert.equal(l.pwd, sub);
  });
  test('status shows state, elapsed, size and the session id', async () => {
    const id = await startArgv({ prompt: 'p' }); assert.match(await s.text('opencode_status', { id }), /^done \(\d+s, 11 chars, session ses_fake01\) worker\/easy\/blueprint$/);
  });
  test('result tail returns only the end', async () => {
    const id = await startArgv({ prompt: 'p' }); assert.equal(await s.text('opencode_result', { id, tail: 5 }), '[done]\nworld');
  });
  test('list shows the bridge tasks with session ids; unknown id points to opencode_sessions', async () => {
    assert.match(await s.text('opencode_list'), /^\w{8} done \d+s ses_fake01/m);
    const r = await s.call('opencode_status', { id: 'nope' }); assert.equal(r.isError, true); assert.match(r.content[0].text, /opencode_sessions/);
  });
  test('failed worker: status failed, stderr surfaces in result', async () => {
    const s2 = startServer({ env: { FAKE_EXIT: '3' } });
    try {
      const id = (await s2.text('opencode_start', { tier: 'easy', prompt: 'p' })).match(/task (\w+)/)[1];
      await waitFor(async () => /^failed/.test(await s2.text('opencode_status', { id })));
      assert.match(await s2.text('opencode_result', { id }), /\[failed\]\nhello world/);
    } finally { s2.close(); }
  });
  test('running worker: result shows partial text; cancel kills it; status cancelled', async () => {
    const s2 = startServer({ env: { FAKE_SLEEP: '30' } });
    try {
      const id = (await s2.text('opencode_start', { tier: 'easy', prompt: 'p' })).match(/task (\w+)/)[1];
      await waitFor(async () => (await s2.text('opencode_result', { id })).includes('hello'));
      assert.match(await s2.text('opencode_result', { id }), /^\[running\]\nhello $/);
      assert.equal(await s2.text('opencode_cancel', { id }), 'cancelled');
      await waitFor(async () => /^cancelled/.test(await s2.text('opencode_status', { id })));
    } finally { s2.close(); }
  });
  test('OPENCODE_BRIDGE_AGENT and OPENCODE_BRIDGE_MODEL are honoured', async () => {
    const f = join(tmp(), 'l'); const s2 = startServer({ env: { FAKE_LOG: f, OPENCODE_BRIDGE_AGENT: 'fixer', OPENCODE_BRIDGE_MODEL: 'prov/mod#hi' } });
    try { await s2.text('opencode_start', { tier: 'easy', prompt: 'p' }); await waitFor(() => readLog(f).length);
      const r = readLog(f)[0].argv; assert.equal(r[r.indexOf('--agent') + 1], 'fixer'); assert.equal(r[r.indexOf('-m') + 1], 'prov/mod#hi'); assert.match(r[r.indexOf('--title') + 1], /\/fixer: p$/);
    } finally { s2.close(); }
  });
});

// ---------------------------------------------------------------- opencode_sessions
describe('opencode_sessions', () => {
  const log = join(tmp(), 'log'); let s;
  before(() => { s = startServer({ env: { FAKE_LOG: log } }); }); after(() => s.close());
  const ls = (a) => s.text('opencode_sessions', a);

  test('default: 25 newest rows, header with filters, ids in order', async () => {
    const t = await ls({}); assert.match(lines(t)[0], /^25 session\(s\) \(state=all\); scanned 100; service-active ids: 2$/);
    assert.deepEqual(idsIn(t), Array.from({ length: 25 }, (_, i) => 'ses_' + String(i).padStart(3, '0')));
  });
  test('row columns: id, state, agent, age, tokens, dir tail, title', async () => {
    const row = lines(await ls({ limit: 1 }))[1];
    assert.match(row, /^ses_000  running\s+deep-research\s+1m ago\s+1k\/10 tok\s+Github\/project-a\s+ALPHA\/deep-research: api reference notes$/);
  });
  test('state=running: recent no-outcome sessions and sessions the service reports active; stale excluded', async () => {
    assert.deepEqual(idsIn(await ls({ state: 'running' })), ['ses_000', 'ses_001', 'ses_003']);
  });
  test('state=active is an alias of running', async () => { assert.deepEqual(idsIn(await ls({ state: 'active' })), ['ses_000', 'ses_001', 'ses_003']); });
  test('state=stale: no outcome, quiet for > 45 min, not in the active list', async () => {
    const t = await ls({ state: 'stale' }); assert.deepEqual(idsIn(t), ['ses_002']); assert.match(t, /stale\?/);
  });
  test('state=running stops paging early (does not scan the whole history)', async () => {
    const t = await ls({ state: 'running' }); assert.match(lines(t)[0], /scanned 100;/);
    const pages = readLog(log).filter((l) => l.path === '/api/session' && l.query.limit === '100'); assert.ok(pages.length >= 1);
  });
  test('state=finished excludes running and stale', async () => {
    const ids = idsIn(await ls({ state: 'finished', limit: 200 })); assert.equal(ids.length, 126);
    for (const x of ['ses_000', 'ses_001', 'ses_002', 'ses_003']) assert.ok(!ids.includes(x));
  });
  for (const st of ['succeeded', 'failed', 'interrupted']) test(`state=${st}`, async () => {
    const t = await ls({ state: st, limit: 200 }); const rows = lines(t).slice(1); assert.ok(rows.length > 10);
    for (const r of rows) assert.match(r, new RegExp(`^ses_\\d{3}  ${st}\\s`));
  });
  test('pagination: limit 200 walks the cursor across pages and returns every session once', async () => {
    const ids = idsIn(await ls({ limit: 200 })); assert.equal(ids.length, 130); assert.equal(new Set(ids).size, 130); assert.equal(ids.at(-1), 'ses_129');
  });
  test('limit clamps: 0 and NaN use the default, 9999 is capped at 200', async () => {
    assert.equal(idsIn(await ls({ limit: 0 })).length, 25); assert.equal(idsIn(await ls({ limit: 'abc' })).length, 25); assert.equal(idsIn(await ls({ limit: 9999 })).length, 130);
    assert.equal(idsIn(await ls({ limit: -5 })).length, 1);
  });
  test('agent filter', async () => {
    const rows = lines(await ls({ agent: 'explorer', limit: 200 })).slice(1); assert.ok(rows.length >= 10); for (const r of rows) assert.match(r, /^ses_\d{3}  \S+\s+explorer /);
  });
  test('directory filter (substring of the session directory)', async () => {
    const rows = lines(await ls({ directory: 'project-b', limit: 200 })).slice(1); assert.ok(rows.length >= 10); for (const r of rows) assert.match(r, /Github\/project-b/);
  });
  test('title_prefix is a prefix, not a substring, and is narrowed server-side first', async () => {
    const t = await ls({ title_prefix: 'ALPHA/', limit: 200 }); const rows = lines(t).slice(1); assert.ok(rows.length >= 5);
    for (const r of rows) assert.match(r, /\s ?ALPHA\/\S+: /);
    assert.ok(!/DOCS-SYNC\/oracle/.test(t));
    assert.equal(readLog(log).filter((l) => l.query?.search === 'ALPHA/').length > 0, true);
    assert.match(await ls({ title_prefix: 'HA/' }), /^0 session\(s\)/); // 'ALPHA/..' contains 'HA/' but does not start with it
  });
  test('search is passed to the server', async () => {
    const t = await ls({ search: 'auto title', limit: 200 }); const rows = lines(t).slice(1); assert.ok(rows.length >= 10); for (const r of rows) assert.match(r, /Some auto title/);
  });
  test('since_minutes keeps only recent sessions', async () => {
    assert.deepEqual(idsIn(await ls({ since_minutes: 10 })), ['ses_000', 'ses_001']);
    assert.match(lines(await ls({ since_minutes: 10 }))[0], /last 10m/);
  });
  test('children=false hides child sessions (parentID); children rows are marked', async () => {
    const withKids = await ls({ limit: 200 }); const without = await ls({ limit: 200, children: false });
    assert.ok(/↳ /.test(withKids)); assert.ok(!/↳ /.test(without)); assert.ok(idsIn(without).length < idsIn(withKids).length); assert.ok(!idsIn(without).includes('ses_010'));
  });
  test('combined filters', async () => {
    const t = await ls({ state: 'succeeded', agent: 'fixer', directory: 'project-a', title_prefix: 'GAMMA/', limit: 200 });
    for (const r of lines(t).slice(1)) assert.match(r, /succeeded\s+fixer\s.*project-a\s+GAMMA\/fixer/);
  });
  test('no match gives a header line only', async () => { assert.equal(lines(await ls({ agent: 'nobody' })).length, 1); assert.match(await ls({ agent: 'nobody' }), /^0 session\(s\)/); });
  test('legacy auto-generated titles are listed unchanged', async () => { assert.match(await ls({ search: 'Some auto title 7' }), /Some auto title 7$/m); });
  test('long titles are clipped to 90 chars with an ellipsis', async () => {
    const s2 = startServer({ env: { FAKE_STATE: join(tmp(), 'st.json') } });
    try { await s2.text('opencode_session_rename', { id: 'ses_005', title: 'L/x: ' + 'w'.repeat(200) }); const row = (await s2.text('opencode_sessions', { search: 'L/x', limit: 1 })).split('\n')[1]; assert.match(row, /w…$/); assert.ok(row.split(/\s{2,}/).at(-1).length <= 90); }
    finally { s2.close(); }
  });
  test('/active failing degrades gracefully to the recency rule', async () => {
    const s2 = startServer({ env: { FAKE_ACTIVE_FAIL: '1' } });
    try { const t = await s2.text('opencode_sessions', { state: 'running' }); assert.deepEqual(idsIn(t), ['ses_000', 'ses_001']); assert.match(t, /service-active ids: 0/); } finally { s2.close(); }
  });
  test('API failure -> isError with the cause', async () => {
    const s2 = startServer({ env: { FAKE_FAIL: '1' } });
    try { const r = await s2.call('opencode_sessions', {}); assert.equal(r.isError, true); assert.match(r.content[0].text, /opencode api GET \/api\/session failed: boom/); } finally { s2.close(); }
  });
  test('non-JSON reply -> isError', async () => {
    const s2 = startServer({ env: { FAKE_NONJSON: '1' } });
    try { const r = await s2.call('opencode_sessions', {}); assert.equal(r.isError, true); assert.match(r.content[0].text, /non-JSON/); } finally { s2.close(); }
  });
  test('missing opencode binary -> isError, server survives', async () => {
    const s2 = startServer({ fake: false, env: { PATH: '/nonexistent' } });
    try { const r = await s2.call('opencode_sessions', {}); assert.equal(r.isError, true); assert.deepEqual((await s2.rpc('ping')).result, {}); } finally { s2.close(); }
  });
});

// ---------------------------------------------------------------- opencode_session_output
describe('opencode_session_output', () => {
  let s; before(() => { s = startServer(); }); after(() => s.close());
  const out = (a) => s.text('opencode_session_output', a);

  test('header: id, state, agent, updated age, tokens, directory | title', async () => {
    const h = lines(await out({ id: 'ses_000' }));
    assert.match(h[0], /^ses_000  running  deep-research  updated 1m ago  1k\/10 tok$/); assert.match(h[1], /Github\/project-a  \|  ALPHA\/deep-research: api reference notes$/);
  });
  test('tail is chronological: agent switch, user, synthetic, assistant text, tool calls, idle with outcome', async () => {
    const t = await out({ id: 'ses_000', messages: 20 });
    const order = ['agent → deep-research', 'user: Do the thing', 'synthetic: Your last response', 'assistant: plan text', '→ execute(', '→ bash(', '→ read(', 'assistant: FINAL ANSWER', 'idle (succeeded)'].map((x) => t.indexOf(x));
    assert.ok(order.every((i) => i >= 0), JSON.stringify(order)); assert.deepEqual([...order].sort((a, b) => a - b), order);
  });
  test('reasoning blocks and their encrypted blobs never appear', async () => {
    const t = await out({ id: 'ses_000', messages: 20, max_chars: 60000 }); assert.ok(!t.includes('SECRETBLOB')); assert.ok(!t.includes('thinking about it'));
  });
  test('tool calls show name, truncated input, status, truncated result; running tools have no result', async () => {
    const t = await out({ id: 'ses_000', messages: 20 });
    assert.match(t, /→ execute\(\{"code":"const x = await fetch\([^)]*…\) \[completed\] ⇒ \[\{"type":"text","text":"R*…$/m.source ? /→ execute\(/ : /x/);
    assert.match(t, /→ bash\(\{"command":"sleep 99"\}\) \[running\]$/m);
    assert.match(t, /→ read\(\{"path":"\/x"\}\) \[completed\] ⇒ \{"lines":3,"note":"object result"\}/);
    const exec = lines(t).find((l) => l.includes('→ execute(')); assert.ok(exec.length < 120 + 3 * 220, 'clipped');
  });
  test('tool_chars widens / narrows the clip', async () => {
    const wide = lines(await out({ id: 'ses_000', messages: 20, tool_chars: 1000 })).find((l) => l.includes('→ execute(')); const narrow = lines(await out({ id: 'ses_000', messages: 20, tool_chars: 40 })).find((l) => l.includes('→ execute('));
    assert.ok(wide.length > narrow.length + 200); assert.ok(narrow.length < 200);
    assert.ok(lines(await out({ id: 'ses_000', messages: 20, tool_chars: 1 })).find((l) => l.includes('→ execute(')).length < 200); // clamped to 40
  });
  test('mode=last returns only the final assistant answer', async () => {
    const t = await out({ id: 'ses_000', mode: 'last' }); assert.ok(t.endsWith('FINAL ANSWER line1\nline2')); assert.ok(!t.includes('plan text')); assert.ok(!t.includes('→'));
  });
  test('mode=last with no assistant text explains itself', async () => {
    assert.match(await out({ id: 'ses_001', mode: 'last' }), /\(no assistant text in the last 2 messages; use mode=tail/);
  });
  test('mode=last on a session with no messages', async () => { assert.match(await out({ id: 'ses_002', mode: 'last' }), /\(no assistant text in the last 0 messages/); });
  test('empty session in tail mode', async () => { assert.match(await out({ id: 'ses_002' }), /\n\(no messages\)$/); });
  test('running tool in an unfinished session shows [running]', async () => { assert.match(await out({ id: 'ses_001' }), /→ bash\(\{"command":"make"\}\) \[running\]/); });
  test('messages param limits how many recent messages are fetched; default 12; max 200', async () => {
    const def = await out({ id: 'ses_004', max_chars: 60000 }); const n = (t) => (t.match(/^\[[\d:]+\] (user|assistant):/gm) || []).length;
    assert.equal(n(def), 12); assert.equal(n(await out({ id: 'ses_004', messages: 3, max_chars: 60000 })), 3); assert.equal(n(await out({ id: 'ses_004', messages: 500, max_chars: 60000 })), 150);
    assert.equal(n(await out({ id: 'ses_004', messages: 0, max_chars: 60000 })), 12);
    assert.match(await out({ id: 'ses_004', messages: 2, max_chars: 60000 }), /ask 148[\s\S]*reply 149/); // the newest two, in order
  });
  test('max_chars cuts from the front, keeps the end, marks the cut; min 500, max 60000', async () => {
    const t = await out({ id: 'ses_003', max_chars: 1000 }); assert.match(t, /…\[cut\]\nA+THE-END$/); assert.ok(t.split('-'.repeat(40) + '\n')[1].length <= 1010);
    const small = await out({ id: 'ses_003', max_chars: 10 }); assert.ok(small.split('-'.repeat(40) + '\n')[1].length >= 500);
    const big = await out({ id: 'ses_003', max_chars: 1e9 }); assert.ok(big.includes('THE-END') && big.length > 9000);
  });
  test('mode=full renders all fetched messages like tail', async () => {
    const full = await out({ id: 'ses_000', mode: 'full', messages: 200, max_chars: 60000 }); const tail = await out({ id: 'ses_000', mode: 'tail', messages: 200, max_chars: 60000 }); assert.equal(full, tail);
  });
  test('plain user message without content blocks (text field) is rendered', async () => { assert.match(await out({ id: 'ses_010' }), /user: prompt 10/); });
  test('multi-line user text is collapsed to one line', async () => { assert.match(await out({ id: 'ses_000', messages: 20 }), /user: Do the thing second line of the prompt/); });
  test('unknown session id -> isError with the HTTP cause', async () => {
    const r = await s.call('opencode_session_output', { id: 'ses_zzz' }); assert.equal(r.isError, true); assert.match(r.content[0].text, /404/);
  });
  test('id is required in practice: empty id gives an error, not a crash', async () => { assert.equal((await s.call('opencode_session_output', { id: '' })).isError, true); assert.deepEqual((await s.rpc('ping')).result, {}); });
  test('ids with odd characters are URL-encoded, not interpreted', async () => { assert.equal((await s.call('opencode_session_output', { id: '../ses_000' })).isError, true); });
});

// ---------------------------------------------------------------- opencode_session_rename
describe('opencode_session_rename', () => {
  const log = join(tmp(), 'log'); const state = join(tmp(), 'state.json'); let s;
  before(() => { s = startServer({ env: { FAKE_LOG: log, FAKE_STATE: state } }); }); after(() => s.close());

  test('renames (PATCH with {title}) and reports the new title; later reads see it', async () => {
    assert.equal(await s.text('opencode_session_rename', { id: 'ses_020', title: 'ALPHA/explorer: new name' }), 'title is now: ALPHA/explorer: new name');
    const p = readLog(log).find((l) => l.method === 'PATCH'); assert.equal(p.path, '/api/session/ses_020'); assert.deepEqual(p.body, { title: 'ALPHA/explorer: new name' });
    assert.match(await s.text('opencode_sessions', { search: 'new name' }), /ses_020/); assert.match(await s.text('opencode_session_output', { id: 'ses_020' }), /ALPHA\/explorer: new name/);
  });
  test('title is trimmed', async () => { assert.match(await s.text('opencode_session_rename', { id: 'ses_021', title: '  A/b: c  ' }), /^title is now: A\/b: c$/m); });
  test('titles that break the convention are accepted but flagged', async () => {
    for (const bad of ['plain title', 'lane/agent no colon', '/agent: x', 'LANE/Agent: x']) assert.match(await s.text('opencode_session_rename', { id: 'ses_022', title: bad }), /does not match the convention/, bad);
    for (const good of ['ALPHA/deep-research: x', 'DOCS-SYNC/fixer: a b c', 'my.repo_1/worker: y']) assert.ok(!/does not match/.test(await s.text('opencode_session_rename', { id: 'ses_022', title: good })), good);
  });
  test('empty / blank / missing title is rejected before any request', async () => {
    const n = readLog(log).length;
    for (const title of ['', '   ', undefined]) { const r = await s.call('opencode_session_rename', { id: 'ses_023', title }); assert.equal(r.isError, true); assert.match(r.content[0].text, /title is empty/); }
    assert.equal(readLog(log).length, n);
  });
  test('unknown session -> isError (404)', async () => { const r = await s.call('opencode_session_rename', { id: 'ses_999', title: 'A/b: c' }); assert.equal(r.isError, true); assert.match(r.content[0].text, /404/); });
  test('unicode titles survive the round trip', async () => { assert.match(await s.text('opencode_session_rename', { id: 'ses_024', title: 'ALPHA/lit: entropie ünïcode → ok' }), /entropie ünïcode → ok/); });
});

// ---------------------------------------------------------------- opencode_processes (real binary named `opencode`)
describe('opencode_processes', () => {
  const dir = tmp(); const stub = buildStub(dir); const kids = [];
  const run = (args, cwd = dir) => { const c = spawn(stub, args, { cwd, env: { ...process.env, STUB_SECONDS: '25' }, stdio: 'ignore' }); kids.push(c); return c; };
  let s; before(() => { s = startServer(); }); after(() => { kids.forEach((k) => k.kill()); s.close(); });
  const t = { skip: stub ? false : 'no C compiler' };

  test('run with a spaced title: exact title, agent, cwd tail, elapsed, pid', t, async () => {
    const c = run(['run', '--title', 'LANE/explorer: has several spaces', '--agent', 'explorer', '--auto', 'the message']);
    const text = await waitFor(async () => { const x = await s.text('opencode_processes'); return x.includes(String(c.pid)) && x; });
    const row = lines(text).find((l) => l.includes(String(c.pid)));
    assert.match(row, /run\s+explorer\s/); assert.ok(row.endsWith('LANE/explorer: has several spaces')); assert.match(row, /\d\d:\d\d/);
    assert.match(text, /^pid\s+elapsed\s+kind\s+agent/);
  });
  test('run without a title shows the task text, skipping flags and their values', async (ctx) => {
    if (!stub) return ctx.skip();
    const c = run(['run', '-m', 'prov/model#xhigh', '--agent', 'fixer', '--auto', 'fix the failing test please']);
    const row = lines(await waitFor(async () => { const x = await s.text('opencode_processes'); return x.includes(String(c.pid)) && x; })).find((l) => l.includes(String(c.pid)));
    assert.match(row, /run\s+fixer\s/); assert.ok(row.endsWith('fix the failing test please'), row); assert.ok(!row.includes('prov/model'));
  });
  test('interactive TUI processes (no subcommand) are shown as TUI', async (ctx) => {
    if (!stub) return ctx.skip();
    const c = run(['--yolo', '-c']);
    const row = lines(await waitFor(async () => { const x = await s.text('opencode_processes'); return x.includes(String(c.pid)) && x; })).find((l) => l.includes(String(c.pid)));
    assert.match(row, /TUI\s+-\s/); assert.match(row, /\(interactive\)$/);
  });
  test('service / api / session / mcp subcommands are not work and are hidden', async (ctx) => {
    if (!stub) return ctx.skip();
    const hidden = [run(['serve', '--service']), run(['api', 'GET', '/api/session']), run(['session', 'list']), run(['mcp', 'list']), run(['--standalone', 'serve'])];
    const shown = run(['run', '--title', 'X/y: visible', '--agent', 'oracle', 'm']);
    const text = await waitFor(async () => { const x = await s.text('opencode_processes'); return x.includes(String(shown.pid)) && x; });
    for (const h of hidden) assert.ok(!text.includes(String(h.pid)), `pid ${h.pid} should be hidden`);
  });
  test('flags before the subcommand do not hide a run', async (ctx) => {
    if (!stub) return ctx.skip();
    const c = run(['--log-level', 'debug', 'run', '--title', 'Z/designer: flags first', '--agent', 'designer', 'go']);
    assert.match(await waitFor(async () => { const x = await s.text('opencode_processes'); return x.includes(String(c.pid)) && x; }), /Z\/designer: flags first/);
  });
  test('cwd tail is the last 3 path components', async (ctx) => {
    if (!stub) return ctx.skip();
    const deep = join(dir, 'a', 'b', 'c', 'd'); (await import('node:fs')).mkdirSync(deep, { recursive: true });
    const c = run(['run', '--title', 'D/x: deep', '--agent', 'x', 'm'], deep);
    const row = lines(await waitFor(async () => { const x = await s.text('opencode_processes'); return x.includes(String(c.pid)) && x; })).find((l) => l.includes(String(c.pid)));
    assert.ok(row.includes('b/c/d') && !row.includes('a/b/c/d'));
  });
  test('a finished process disappears from the list', async (ctx) => {
    if (!stub) return ctx.skip();
    const c = run(['run', '--title', 'G/x: going away', '--agent', 'x', 'm']); await waitFor(async () => (await s.text('opencode_processes')).includes(String(c.pid)));
    c.kill(); await waitFor(async () => !(await s.text('opencode_processes')).includes(String(c.pid)));
  });
  test('no processes at all -> a plain message (fake PATH, none spawned)', async () => {
    const s2 = startServer(); try { const x = await s2.text('opencode_processes'); assert.ok(/no opencode run|^pid/.test(x)); } finally { s2.close(); }
  });
});
