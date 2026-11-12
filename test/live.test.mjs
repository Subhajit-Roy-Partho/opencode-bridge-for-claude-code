// Live integration tests against a REAL opencode background service. Opt-in (spends a few thousand tokens):
//   OPENCODE_BRIDGE_LIVE=1 node --test test/live.test.mjs
// Needs: `opencode` on PATH, a running background service, and (for the agent test) the roster agent `explorer`
// from the opencode-config repository. Every session the test creates is deleted again.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { startServer, waitFor, sleep } from './helpers.mjs';

const LIVE = process.env.OPENCODE_BRIDGE_LIVE === '1';
const skip = LIVE ? false : 'set OPENCODE_BRIDGE_LIVE=1 to run the live tests';
const lane = 'BRIDGELIVE' + randomBytes(2).toString('hex').toUpperCase();
const created = new Set();
const api = (m, p) => JSON.parse(execFileSync('opencode', ['api', m, p], { encoding: 'utf8', maxBuffer: 1 << 28 }) || '{}');

describe('live service', { skip }, () => {
  let s, root; before(() => { root = process.cwd(); s = startServer({ fake: false, root, env: { HOME: process.env.HOME } }); });
  after(() => { for (const id of created) { try { execFileSync('opencode', ['api', 'DELETE', `/api/session/${id}`], { stdio: 'ignore' }); } catch {} } s.close(); });

  test('opencode_policy answers for the real working directory', async () => {
    const t = await s.text('opencode_policy', { cwd: root }); assert.match(t, /^ACTIVE MODE: (BLUEPRINT|SENSITIVE|INSENSITIVE)/);
  });
  test('opencode_sessions lists real sessions with the documented columns', async () => {
    const t = await s.text('opencode_sessions', { limit: 5 }); assert.match(t, /^\d+ session\(s\)/);
    for (const row of t.split('\n').slice(1)) assert.match(row, /^ses_\S+\s+(running|succeeded|failed|interrupted|stale\?)\s+\S+\s+\S+ ago\s+\S+ tok/);
  });
  test('opencode_processes runs against the real process table', async () => { assert.match(await s.text('opencode_processes'), /^(pid |no opencode)/); });
  test('end to end: start (explorer, easy) -> running visible -> output -> rename -> finished', async () => {
    const out = await s.text('opencode_start', { prompt: 'Reply with exactly the single word PONG. Do not use tools. Do not touch files.', tier: 'easy', agent: 'explorer', lane, cwd: root });
    const task = out.match(/task (\w+) started/)[1]; assert.match(out, new RegExp(`title: ${lane}/explorer: `));
    // while it runs: the title convention is visible in the process table and the session list
    const proc = await waitFor(async () => { const x = await s.text('opencode_processes'); return x.includes(lane) && x; }, 15000).catch(() => null);
    const st = await waitFor(async () => { const x = await s.text('opencode_status', { id: task }); return /session ses_/.test(x) && x; }, 60000);
    const sid = st.match(/session (ses_\w+)/)[1]; created.add(sid);
    await waitFor(async () => /^done/.test(await s.text('opencode_status', { id: task })), 120000, 500);
    assert.match(await s.text('opencode_result', { id: task }), /PONG/);
    const listed = await s.text('opencode_sessions', { title_prefix: `${lane}/` }); assert.match(listed, new RegExp(`${sid}\\s+succeeded\\s+explorer`));
    const last = await s.text('opencode_session_output', { id: sid, mode: 'last' }); assert.match(last, /PONG/);
    const tail = await s.text('opencode_session_output', { id: sid }); assert.match(tail, /user: Rules: do the work yourself/); assert.match(tail, /READ-ONLY: do not create/); assert.match(tail, /idle \(succeeded\)/);
    assert.match(await s.text('opencode_session_rename', { id: sid, title: `${lane}/explorer: renamed by test` }), /title is now: .*renamed by test$/m);
    assert.match(await s.text('opencode_sessions', { title_prefix: `${lane}/`, state: 'finished' }), /renamed by test/);
    if (proc) assert.match(proc, new RegExp(`${lane}/explorer`)); // the process row carried the exact title
  });
  test('a hard task is refused before anything is started', async () => {
    const r = await s.call('opencode_start', { prompt: 'x', tier: 'hard', agent: 'explorer', cwd: root }); assert.equal(r.isError, true);
    await sleep(500); assert.equal((await s.text('opencode_sessions', { title_prefix: `${lane}/`, limit: 50 })).split('\n').length - 1 <= 1, true);
  });
});
