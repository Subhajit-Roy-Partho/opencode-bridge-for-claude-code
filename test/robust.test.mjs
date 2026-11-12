// Edge cases and error handling: provider errors and their classification, automatic retry rules, timeouts, cancel and process
// groups, parallel limit, oversized prompts, input validation, shutdown, API failures (down / 401 / hung / flaky), output limits,
// failure reasons in session output, protocol robustness, process-table fallback. Offline (fake opencode).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { startServer, tmp, readLog, waitFor, sleep, buildStub } from './helpers.mjs';

const FAST = { OPENCODE_BRIDGE_RETRY_DELAY_S: '0', OPENCODE_BRIDGE_KILL_GRACE_MS: '100', OPENCODE_BRIDGE_TIMEOUT_UNIT_MS: '100' };
const tid = (t) => t.match(/task (\w{8}) started/)[1];
const runs = (f) => readLog(f).filter((l) => l.argv[0] === 'run');
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const lines = (s) => s.split('\n');
async function begin(env, args = {}) {
  const f = join(tmp(), 'log'); const s = startServer({ env: { ...FAST, FAKE_LOG: f, ...env } });
  const t = await s.text('opencode_start', { tier: 'easy', prompt: 'task', agent: 'worker', ...args });
  return { s, f, id: tid(t), reply: t };
}
const final = (s, id, re = /^(done|failed|timeout|cancelled)/) => waitFor(async () => { const x = await s.text('opencode_status', { id }); return re.test(x) && x; }, 15000, 50);

describe('provider errors are parsed, classified, and come with advice', () => {
  const cases = [
    ['provider.no-route', 'Model unavailable: bogus/x', 'model', /Model unavailable\. Check OPENCODE_BRIDGE_MODEL/],
    ['unknown', 'Agent not found: "nosuchagent"', 'agent', /opencode-config/],
    ['provider.rate-limit', '429 Too Many Requests', 'rate_limit', /rate limit/i],
    ['unknown', 'insufficient_quota: You exceeded your current quota', 'quota', /quota or credits are exhausted/i],
    ['unknown', 'Overloaded', 'overloaded', /overloaded or unavailable/],
    ['provider.invalid-request', 'maximum context length is 128000 tokens', 'context_length', /too large for the model's context/],
    ['unknown', 'Invalid API key provided', 'auth', /opencode auth login/],
    ['unknown', 'read ECONNRESET', 'network', /Network problem/],
    ['provider.invalid-request', 'only "auto" is supported for tool_choice', 'invalid_request', /rejected the request/],
    ['unknown', 'output token limit reached', 'output_limit', /output-token limit/],
  ];
  for (const [type, msg, kind, advice] of cases) test(`${kind}: "${msg.slice(0, 40)}"`, async () => {
    const { s, id } = await begin({ FAKE_ERR_TYPE: type, FAKE_ERR_MSG: msg }); try {
      assert.match(await final(s, id), new RegExp(`^failed \\(${kind}\\)`));
      const r = await s.text('opencode_result', { id }); assert.ok(r.startsWith(`[failed: ${kind}]\n${type}: ${msg}\n`), r); assert.match(r, advice); assert.ok(/^Advice: /m.test(r));
    } finally { s.close(); }
  });
  test('an unclassified failure keeps its message, kind "exit", and no advice line', async () => {
    const { s, id } = await begin({ FAKE_ERR_MSG: 'something odd happened' }); try { await final(s, id); const r = await s.text('opencode_result', { id }); assert.match(r, /^\[failed: exit\]\nunknown: something odd happened$/); } finally { s.close(); }
  });
  test('a failure with only a stderr line (no events): that line is the message', async () => {
    const { s, id } = await begin({ FAKE_STDERR_ONLY: 'Error: something broke badly' }); try { await final(s, id); assert.match(await s.text('opencode_result', { id }), /^\[failed: exit\]\nError: something broke badly/); } finally { s.close(); }
  });
  test('stderr text is classified too (a 429 on stderr is a rate limit)', async () => {
    const { s, id } = await begin({ FAKE_STDERR_ONLY: 'Error: 429 Too Many Requests' }); try { assert.match(await final(s, id), /^failed \(rate_limit\)/); } finally { s.close(); }
  });
  test('exit 0 with an error event and no output is a failure', async () => {
    const { s, id } = await begin({ FAKE_ERR_TYPE: 'provider.no-route', FAKE_ERR_MSG: 'Model unavailable: z', FAKE_ERR_EXIT0: '1' }); try { assert.match(await final(s, id), /^failed \(model\)/); } finally { s.close(); }
  });
  test('exit 0 with output and an error event is done, with a visible warning', async () => {
    const { s, id } = await begin({ FAKE_TEXT_FIRST: '1', FAKE_ERR_TYPE: 'unknown', FAKE_ERR_MSG: 'minor hiccup', FAKE_ERR_EXIT0: '1' }); try {
      assert.match(await final(s, id), /^done .*\[1 error event\(s\) during the run\]$/);
      const r = await s.text('opencode_result', { id }); assert.match(r, /^\[done\]\nwarning: 1 error event\(s\) during the run, first: unknown: minor hiccup\nhello world$/);
    } finally { s.close(); }
  });
  test('error text is only taken from error events / stderr, never from the model output', async () => {
    const { s, id } = await begin({ FAKE_TEXT_FIRST: '1', FAKE_ERR_MSG: 'plain', FAKE_ERR_EXIT0: '1' }); try { await final(s, id); assert.ok(!/rate_limit|quota/.test(await s.text('opencode_status', { id }))); } finally { s.close(); }
  });
  test('opencode_list shows the failure kind', async () => {
    const { s, id } = await begin({ FAKE_ERR_TYPE: 'provider.rate-limit', FAKE_ERR_MSG: '429' }); try { await final(s, id); assert.match(await s.text('opencode_list'), new RegExp(`${id} failed:rate_limit `)); } finally { s.close(); }
  });
});

describe('automatic retry only where it is safe', () => {
  const rl = { FAKE_ERR_TYPE: 'provider.rate-limit', FAKE_ERR_MSG: '429 Too Many Requests' };
  test('read-only agent + transient error: retried with new attempts until it succeeds', async () => {
    const cf = join(tmp(), 'count'); const { s, f, id } = await begin({ ...rl, FAKE_FAIL_TIMES: '2', FAKE_COUNT_FILE: cf }, { agent: 'explorer' }); try {
      const st = await final(s, id); assert.match(st, /^done \(\d+s, 11 chars, session ses_fake01, attempt 3\) explorer\/easy\/blueprint$/); assert.equal(runs(f).length, 3);
      assert.match(await s.text('opencode_result', { id }), /^\[done\]\nhello world$/);
    } finally { s.close(); }
  });
  for (const [label, env] of [['overloaded', { FAKE_ERR_MSG: 'Overloaded' }], ['network', { FAKE_ERR_MSG: 'read ECONNRESET' }]]) test(`${label} is transient too`, async () => {
    const cf = join(tmp(), 'c'); const { s, f, id } = await begin({ ...env, FAKE_FAIL_TIMES: '1', FAKE_COUNT_FILE: cf }, { agent: 'librarian' }); try { assert.match(await final(s, id), /^done/); assert.equal(runs(f).length, 2); } finally { s.close(); }
  });
  test('retries are bounded by OPENCODE_BRIDGE_RETRIES, then the task fails with advice', async () => {
    const cf = join(tmp(), 'c'); const { s, f, id } = await begin({ ...rl, FAKE_FAIL_TIMES: '99', FAKE_COUNT_FILE: cf, OPENCODE_BRIDGE_RETRIES: '1' }, { agent: 'oracle' }); try {
      assert.match(await final(s, id), /^failed \(rate_limit\) .*attempt 2\)/); assert.equal(runs(f).length, 2); assert.match(await s.text('opencode_result', { id }), /Advice: Provider rate limit/);
    } finally { s.close(); }
  });
  test('OPENCODE_BRIDGE_RETRIES=0 disables retrying', async () => {
    const { s, f, id } = await begin({ ...rl, OPENCODE_BRIDGE_RETRIES: '0' }, { agent: 'explorer' }); try { await final(s, id); await sleep(200); assert.equal(runs(f).length, 1); } finally { s.close(); }
  });
  test('an EDITING agent is never replayed, even for a transient error', async () => {
    const cf = join(tmp(), 'c'); for (const agent of ['worker', 'fixer', 'designer', 'general']) {
      const { s, f, id } = await begin({ ...rl, FAKE_FAIL_TIMES: '2', FAKE_COUNT_FILE: cf + agent }, { agent }); try { assert.match(await final(s, id), /^failed \(rate_limit\)/, agent); await sleep(150); assert.equal(runs(f).length, 1, agent); } finally { s.close(); }
    }
  });
  for (const [kind, msg] of [['quota', 'insufficient_quota'], ['auth', 'Invalid API key'], ['context_length', 'maximum context length exceeded'], ['model', 'Model unavailable: x']]) test(`non-transient ${kind} is not retried`, async () => {
    const { s, f, id } = await begin({ FAKE_ERR_MSG: msg }, { agent: 'explorer' }); try { assert.match(await final(s, id), new RegExp(`^failed \\(${kind}\\)`)); await sleep(200); assert.equal(runs(f).length, 1); } finally { s.close(); }
  });
  test('no retry once output was produced (the work may be half done), the partial output is kept', async () => {
    const { s, f, id } = await begin({ ...rl, FAKE_TEXT_FIRST: '1' }, { agent: 'explorer' }); try {
      assert.match(await final(s, id), /^failed \(rate_limit\)/); await sleep(200); assert.equal(runs(f).length, 1); assert.match(await s.text('opencode_result', { id }), /--- partial output ---\nhello $/);
    } finally { s.close(); }
  });
  test('while waiting to retry: status "retrying", result says when; the slot counts as running; cancel stops the retry', async () => {
    const { s, f, id } = await begin({ ...rl, OPENCODE_BRIDGE_RETRY_DELAY_S: '2' }, { agent: 'explorer' }); try {
      const st = await waitFor(async () => { const x = await s.text('opencode_status', { id }); return /^retrying \(rate_limit\) in \d+s/.test(x) && x; }, 8000, 50);
      assert.match(await s.text('opencode_result', { id }), /waiting \d+s before attempt 2 of 3/);
      assert.equal(await s.text('opencode_cancel', { id }), 'cancelled'); await sleep(2500); assert.equal(runs(f).length, 1); assert.match(await s.text('opencode_status', { id }), /^cancelled/);
    } finally { s.close(); }
  });
});

describe('time limits, cancel, process groups', () => {
  test('timeout kills the run, status "timeout", message and advice, partial output kept', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '30' }, { timeout_minutes: 2 }); try {
      assert.match(await final(s, id), /^timeout \(timeout\)/);
      const r = await s.text('opencode_result', { id }); assert.match(r, /^\[timeout: timeout\]\nno result after 200 ms; the process group was killed\nAdvice: Split the task/); assert.match(r, /--- partial output ---\nhello $/);
    } finally { s.close(); }
  });
  test('a process that ignores SIGTERM is SIGKILLed after the grace period', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '30', FAKE_NOTERM: '1' }, { timeout_minutes: 1 }); try { assert.match(await final(s, id), /^timeout/); } finally { s.close(); }
  });
  test('the whole process group dies with the run (children of opencode too): timeout, cancel', async () => {
    for (const how of ['timeout', 'cancel']) {
      const pf = join(tmp(), 'pid'); const { s, id } = await begin({ FAKE_SLEEP: '60', FAKE_CHILD_PIDFILE: pf }, how === 'timeout' ? { timeout_minutes: 3 } : {}); try {
        const pid = await waitFor(() => existsSync(pf) && readFileSync(pf, 'utf8'), 5000); assert.ok(alive(pid), 'child alive while running');
        if (how === 'cancel') assert.equal(await s.text('opencode_cancel', { id }), 'cancelled');
        await waitFor(() => !alive(pid), 5000, 50);
      } finally { s.close(); }
    }
  });
  test('cancel: running -> cancelled; again / finished -> "already"; status stays cancelled', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '30' }); try {
      assert.equal(await s.text('opencode_cancel', { id }), 'cancelled'); assert.equal(await s.text('opencode_cancel', { id }), 'task already cancelled; nothing to cancel');
      await sleep(400); assert.match(await s.text('opencode_status', { id }), /^cancelled/); assert.match(await s.text('opencode_result', { id }), /^\[cancelled\]/);
    } finally { s.close(); }
    const b = await begin({}); try { await final(b.s, b.id, /^done/); assert.equal(await b.s.text('opencode_cancel', { id: b.id }), 'task already done; nothing to cancel'); } finally { b.s.close(); }
  });
  test('parallel limit: refused with the running tasks listed; frees up on cancel; finished tasks do not count', async () => {
    const f = join(tmp(), 'l'); const s = startServer({ env: { ...FAST, FAKE_LOG: f, FAKE_SLEEP: '30', OPENCODE_BRIDGE_MAX_PARALLEL: '2' } }); try {
      const a = tid(await s.text('opencode_start', { tier: 'easy', prompt: 'one' })); const b = tid(await s.text('opencode_start', { tier: 'easy', prompt: 'two' }));
      const r = await s.call('opencode_start', { tier: 'easy', prompt: 'three' }); assert.equal(r.isError, true);
      assert.match(r.content[0].text, new RegExp(`parallel limit reached \\(2/2 tasks running or waiting to retry\\): ${a} worker .*; ${b} worker .*OPENCODE_BRIDGE_MAX_PARALLEL`));
      await s.text('opencode_cancel', { id: a }); assert.ok(!(await s.call('opencode_start', { tier: 'easy', prompt: 'four' })).isError);
    } finally { s.close(); }
    const s2 = startServer({ env: { ...FAST, OPENCODE_BRIDGE_MAX_PARALLEL: '1' } }); try { for (let i = 0; i < 4; i++) { const id = tid(await s2.text('opencode_start', { tier: 'easy', prompt: 'x' + i })); await final(s2, id, /^done/); } } finally { s2.close(); }
  });
  test('a retrying task occupies a parallel slot', async () => {
    const s = startServer({ env: { ...FAST, OPENCODE_BRIDGE_RETRY_DELAY_S: '5', OPENCODE_BRIDGE_MAX_PARALLEL: '1', FAKE_ERR_MSG: '429 Too Many Requests', FAKE_ERR_TYPE: 'provider.rate-limit' } }); try {
      const id = tid(await s.text('opencode_start', { tier: 'easy', prompt: 'x', agent: 'explorer' })); await waitFor(async () => /^retrying/.test(await s.text('opencode_status', { id })), 5000, 50);
      assert.match((await s.call('opencode_start', { tier: 'easy', prompt: 'y', agent: 'explorer' })).content[0].text, /parallel limit reached \(1\/1/);
    } finally { s.close(); }
  });
  test('env limits are validated: junk falls back to the defaults', async () => {
    const s = startServer({ env: { OPENCODE_BRIDGE_MAX_PARALLEL: 'abc', OPENCODE_BRIDGE_TIMEOUT_MIN: '-5', OPENCODE_BRIDGE_RETRIES: '999' } }); try {
      const t = await s.text('opencode_start', { tier: 'easy', prompt: 'x', agent: 'explorer' }); assert.match(t, /Limits: 1\/6 parallel, timeout 1 min, up to 5 automatic retries/);
    } finally { s.close(); }
  });
});

describe('prompt size and input validation', () => {
  test('a prompt over ~100 KB is attached as a 0600 file, the message points at it, the file is removed afterwards', async () => {
    const big = 'x'.repeat(150_000) + 'THE-END'; const { s, f, id, reply } = await begin({}, { prompt: big }); try {
      assert.match(reply, /prompt 14[67] KB sent as an attached file/); await final(s, id, /^done/);
      const r = runs(f)[0]; assert.ok(r.attached, 'attached'); assert.equal(r.attached.mode, '600'); assert.ok(r.attached.bytes > 150_000); assert.match(r.attached.head, /^Rules: do the work yourself/);
      const msg = r.argv.at(-1); assert.ok(msg.length < 2000); assert.match(msg, /The complete task is in the attached file task\.md\. Read it first and follow it exactly\.$/); assert.ok(r.argv.indexOf('-f') < r.argv.length - 1);
      await waitFor(() => !existsSync(dirname(r.attached.path)), 3000, 50);
    } finally { s.close(); }
  });
  test('a prompt under the limit stays on the command line', async () => {
    const { s, f, id } = await begin({}, { prompt: 'y'.repeat(90_000) }); try { await final(s, id, /^done/); assert.equal(runs(f)[0].attached, undefined); assert.ok(runs(f)[0].argv.at(-1).length > 90_000); } finally { s.close(); }
  });
  test('the attached file is removed when the task fails, times out or is cancelled', async () => {
    for (const env of [{ FAKE_ERR_MSG: 'quota exceeded' }, { FAKE_SLEEP: '30', __cancel: '1' }]) {
      const { s, f, id } = await begin({ ...env }, { prompt: 'z'.repeat(120_000), ...(env.FAKE_SLEEP ? { timeout_minutes: 2 } : {}) }); try {
        await waitFor(() => runs(f).length); const dir = dirname(runs(f)[0].attached.path); await final(s, id); await waitFor(() => !existsSync(dir), 3000, 50);
      } finally { s.close(); }
    }
  });
  test('a prompt over 5 MB is refused with advice', async () => {
    const s = startServer({ env: FAST }); try { const r = await s.call('opencode_start', { tier: 'easy', prompt: 'a'.repeat(5_100_000) }); assert.equal(r.isError, true); assert.match(r.content[0].text, /prompt is too large \(> 5 MB\): put the material in files/); } finally { s.close(); }
  });
  test('the secret guard also covers attached (large) prompts', async () => {
    const s = startServer({ env: FAST }); try { const r = await s.call('opencode_start', { tier: 'easy', prompt: 'x'.repeat(120_000) + ' ghp_abcdefghijklmnopqrstuvwxyz0123456789' }); assert.match(r.content[0].text, /looks like it contains a secret/); } finally { s.close(); }
  });
  test('empty / blank / missing prompts are refused; a number is accepted as text', async () => {
    const s = startServer({ env: FAST }); try {
      for (const prompt of ['', '   \n ', undefined, null]) { const r = await s.call('opencode_start', { tier: 'easy', prompt }); assert.equal(r.isError, true); assert.match(r.content[0].text, /prompt is empty/); }
      assert.ok(!(await s.call('opencode_start', { tier: 'easy', prompt: 12345 })).isError);
    } finally { s.close(); }
  });
  test('tier / agent / mode are normalised (case, spaces); unknown values are refused', async () => {
    const f = join(tmp(), 'l'); const s = startServer({ env: { ...FAST, FAKE_LOG: f } }); try {
      const t = await s.text('opencode_start', { tier: ' Easy ', agent: ' FIXER ', prompt: 'p', mode: ' Blueprint ' }); assert.match(t, /agent=fixer tier=easy/); assert.match(t, /title: [A-Z0-9._-]+\/fixer: p/);
      assert.match((await s.call('opencode_start', { tier: 'easy', agent: 'x', prompt: 'p' })).content[0].text, /unknown agent/);
    } finally { s.close(); }
  });
  test('cwd that does not exist -> clear message', async () => {
    const s = startServer({ env: FAST }); try { const r = await s.call('opencode_start', { tier: 'easy', prompt: 'p', cwd: join(s.rootDir, 'nope') }); assert.match(r.content[0].text, /cwd does not exist: /); } finally { s.close(); }
  });
  test('session continuation: unknown id, and a task without a session id yet', async () => {
    const s = startServer({ fake: false, env: { ...FAST, PATH: '/nonexistent' } }); try {
      assert.match((await s.call('opencode_start', { tier: 'easy', prompt: 'p', session: 'nope' })).content[0].text, /unknown task id "nope"/);
      const id = tid(await s.text('opencode_start', { tier: 'easy', prompt: 'p' })); await final(s, id, /^failed/);
      assert.match((await s.call('opencode_start', { tier: 'easy', prompt: 'p', session: id })).content[0].text, /no session id yet/);
    } finally { s.close(); }
  });
  test('titles: control characters stripped, long titles clipped to 200', async () => {
    const f = join(tmp(), 'l'); const s = startServer({ env: { ...FAST, FAKE_LOG: f } }); try {
      await s.text('opencode_start', { tier: 'easy', prompt: 'p', title: 'A/b: one\ntwo\tthree\u0007' }); await s.text('opencode_start', { tier: 'easy', prompt: 'p', title: 'T/x: ' + 'y'.repeat(400) });
      await waitFor(() => runs(f).length === 2); const ts = runs(f).map((r) => r.argv[r.argv.indexOf('--title') + 1]).sort();
      assert.ok(ts.includes('A/b: one two three')); assert.ok(ts.some((x) => x.length === 200 && x.startsWith('T/x: y')));
    } finally { s.close(); }
  });
  test('timeout_minutes: junk -> default, huge -> clamped to 1440', async () => {
    const s = startServer({ env: FAST }); try {
      assert.match(await s.text('opencode_start', { tier: 'easy', prompt: 'p', timeout_minutes: 'abc' }), /timeout 120 min/); assert.match(await s.text('opencode_start', { tier: 'easy', prompt: 'p', timeout_minutes: 99999 }), /timeout 1440 min/);
    } finally { s.close(); }
  });
  test('sensitive mechanical flag accepts the string "true"', async () => {
    const s = startServer({ env: { ...FAST, OPENCODE_MODE: 'sensitive' } }); try { assert.ok(!(await s.call('opencode_start', { tier: 'easy', prompt: 'p', agent: 'fixer', mechanical: 'true' })).isError); } finally { s.close(); }
  });
  test('a missing opencode binary: the task fails with kind "spawn" and install advice (no crash)', async () => {
    const s = startServer({ fake: false, env: { ...FAST, PATH: '/nonexistent' } }); try {
      const id = tid(await s.text('opencode_start', { tier: 'easy', prompt: 'p' })); assert.match(await final(s, id, /^failed/), /^failed \(spawn\)/);
      assert.match(await s.text('opencode_result', { id }), /the opencode binary was not found on PATH\nAdvice: Install opencode/); assert.deepEqual((await s.rpc('ping')).result, {});
    } finally { s.close(); }
  });
  test('large output: 2 MB are kept, truncation is announced; opencode_result caps at 60000 and head / tail work', async () => {
    const { s, id } = await begin({ FAKE_BIGOUT: '3' }); try {
      await final(s, id, /^done/); assert.match(await s.text('opencode_status', { id }), /2000000 chars/);
      const r = await s.text('opencode_result', { id }); assert.match(r, /note: the output exceeded 2 MB; only the last 2 MB are kept/); assert.match(r, /note: 1940000 earlier characters omitted \(output is 2000000\)/); assert.ok(r.length < 61_000);
      const h = await s.text('opencode_result', { id, head: 10 }); assert.ok(/\nCCCCCCCCCC$/.test(h)); assert.ok(h.split('\n').at(-1).length === 10); // 3 MB of B,C,D were sent; the last 2 MB start inside the C block
      const t = await s.text('opencode_result', { id, tail: 7 }); assert.ok(t.endsWith('DDworld'));
      const big = await s.text('opencode_result', { id, tail: 1_900_000 }); assert.ok(big.length <= 100_300); assert.match(big, /characters omitted to stay within the tool-output limit/);
    } finally { s.close(); }
  });
  test('finished tasks are pruned beyond the cap only (a few tasks are never lost)', async () => {
    const s = startServer({ env: FAST }); try { const ids = []; for (let i = 0; i < 5; i++) { const id = tid(await s.text('opencode_start', { tier: 'easy', prompt: 'p' + i })); await final(s, id, /^done/); ids.push(id); } const l = await s.text('opencode_list'); for (const id of ids) assert.ok(l.includes(id)); } finally { s.close(); }
  });
});

describe('shutdown', () => {
  for (const how of ['stdin closed', 'SIGTERM']) test(`${how}: running tasks and their children are killed, the server exits`, async () => {
    const pf = join(tmp(), 'pid'); const { s, id } = await begin({ FAKE_SLEEP: '60', FAKE_CHILD_PIDFILE: pf }, { prompt: 'q'.repeat(120_000) }); try {
      const pid = await waitFor(() => existsSync(pf) && readFileSync(pf, 'utf8'), 5000); assert.ok(alive(pid));
      const exited = new Promise((r) => s.child.once('exit', (code, sig) => r({ code, sig })));
      if (how === 'SIGTERM') s.child.kill('SIGTERM'); else s.child.stdin.end();
      const e = await Promise.race([exited, sleep(5000).then(() => 'timeout')]); assert.notEqual(e, 'timeout', 'server exited'); await waitFor(() => !alive(pid), 3000, 50);
    } finally { s.close(); }
  });
  test('the server survives a client that sends junk after a tool error', async () => {
    const s = startServer({ env: FAST }); try { await s.call('opencode_start', { tier: 'hard', prompt: 'x' }); s.raw('}{\n'); assert.deepEqual((await s.rpc('ping')).result, {}); assert.equal(s.stderr, ''); } finally { s.close(); }
  });
});

describe('opencode service / API failures', () => {
  const sess = (env, tool = 'opencode_sessions', args = {}) => { const s = startServer({ env }); return { s, run: () => s.call(tool, args) }; };
  test('service down: a short, actionable message, not a stack trace', async () => {
    const { s, run } = sess({ FAKE_API_ECONN: '1' }); try { const r = await run(); assert.equal(r.isError, true); const t = r.content[0].text; assert.match(t, /^opencode api GET \/api\/session failed: the opencode background service is not reachable \(is it running\?/); assert.ok(!/chunk-|at cli\./.test(t)); assert.ok(t.length < 400); } finally { s.close(); }
  });
  test('401: authentication message', async () => { const { s, run } = sess({ FAKE_API_401: '1' }); try { assert.match((await run()).content[0].text, /authentication was refused by the opencode service/); } finally { s.close(); } });
  test('a hung service: timeout message with the limit, after one retry of the read', async () => {
    const f = join(tmp(), 'l'); const { s, run } = sess({ FAKE_API_SLEEP: '3000', OPENCODE_BRIDGE_API_TIMEOUT_MS: '300', FAKE_LOG: f }, 'opencode_session_output', { id: 'ses_000' }); try {
      const t0 = Date.now(); const r = await run(); assert.equal(r.isError, true); assert.match(r.content[0].text, /timed out after 300 ms \(the opencode service is busy or hung; retry, or restart it\)/); assert.ok(Date.now() - t0 < 2500);
      assert.ok(readLog(f).filter((l) => l.path === '/api/session/ses_000').length >= 2, 'the GET was retried');
    } finally { s.close(); }
  });
  test('a transient read failure (ECONNRESET) is retried once and succeeds', async () => {
    const f = join(tmp(), 'l'); const fl = join(tmp(), 'flaky'); const { s, run } = sess({ FAKE_API_FLAKY: fl, FAKE_LOG: f }, 'opencode_sessions', { limit: 2 }); try {
      const r = await run(); assert.ok(!r.isError, r.content[0].text); assert.equal(readLog(f).filter((l) => l.path === '/api/session/active').length, 2, 'first call failed, second succeeded');
    } finally { s.close(); }
  });
  test('writes are never retried (rename after ECONNRESET fails once)', async () => {
    const f = join(tmp(), 'l'); const fl = join(tmp(), 'flaky'); const st = join(tmp(), 'st'); const { s, run } = sess({ FAKE_API_FLAKY: fl, FAKE_LOG: f, FAKE_STATE: st }, 'opencode_session_rename', { id: 'ses_020', title: 'A/b: c' }); try {
      const r = await run(); assert.equal(r.isError, true); assert.equal(readLog(f).filter((l) => l.method === 'PATCH').length, 1);
    } finally { s.close(); }
  });
  test('a long scan stops at its deadline and says so (PARTIAL), with the rows found so far', async () => {
    const { s, run } = sess({ FAKE_API_SLEEP: '300', OPENCODE_BRIDGE_SCAN_DEADLINE_MS: '250' }, 'opencode_sessions', { limit: 200 }); try {
      const t = (await run()).content[0].text; assert.match(lines(t)[0], /PARTIAL: time limit \(0 s\) reached after 1 page\(s\), narrow the filters/); assert.equal(lines(t).length - 1, 100);
    } finally { s.close(); }
  });
  test('an API reply over 64 MB is reported with advice, and the server stays up', async () => {
    const { s, run } = sess({ FAKE_API_HUGE: '70' }); try { const r = await run(); assert.equal(r.isError, true); assert.match(r.content[0].text, /the reply was too large \(> 64 MB\): ask for fewer messages \/ a smaller limit/); assert.deepEqual((await s.rpc('ping')).result, {}); } finally { s.close(); }
  });
  test('missing opencode binary on API calls: clear message', async () => {
    const s = startServer({ fake: false, env: { PATH: '/nonexistent' } }); try { assert.match((await s.call('opencode_sessions', {})).content[0].text, /the opencode binary was not found on PATH/); } finally { s.close(); }
  });
});

describe('failure reasons and limits in session output', () => {
  test('a failed session shows the failure kind, message and advice in the header, and the error lines', async () => {
    const s = startServer(); try {
      const t = await s.text('opencode_session_output', { id: 'ses_012' }); const h = lines(t);
      assert.match(h[0], /^ses_012  failed /); assert.ok(t.includes('failure: invalid_request: provider.invalid-request: only "auto" is supported for tool_choice')); assert.match(t, /\nadvice: The provider rejected the request/);
      assert.match(t, /✖ error: provider\.invalid-request: only "auto"/); assert.match(t, /— idle \(failed\) —\n  ✖ error:/);
    } finally { s.close(); }
  });
  test('string errors are handled and classified (context length)', async () => {
    const s = startServer(); try { const t = await s.text('opencode_session_output', { id: 'ses_017' }); assert.match(t, /failure: context_length: maximum context length is 128000 tokens/); assert.match(t, /advice: The prompt or session is too large/); } finally { s.close(); }
  });
  test('output-token-limit steps are flagged, and the synthetic notice is shown', async () => {
    const s = startServer(); try { const t = await s.text('opencode_session_output', { id: 'ses_011' }); assert.match(t, /⚠ output token limit hit in this step \(finish=length\)/); assert.match(t, /synthetic: Your last response hit the output token limit/); assert.ok(!/\nfailure:/.test(t)); } finally { s.close(); }
  });
  test('healthy and running sessions have no failure line', async () => {
    const s = startServer(); try { for (const id of ['ses_000', 'ses_010', 'ses_001']) assert.ok(!/\nfailure:|✖ error/.test(await s.text('opencode_session_output', { id })), id); } finally { s.close(); }
  });
  test('last mode on a failed session still reports the failure in the header', async () => {
    const s = startServer(); try { assert.match(await s.text('opencode_session_output', { id: 'ses_012', mode: 'last' }), /\nfailure: invalid_request:/); } finally { s.close(); }
  });
});

describe('rename sanitising', () => {
  test('control characters stripped, length capped, id required', async () => {
    const st = join(tmp(), 'st'); const s = startServer({ env: { FAKE_STATE: st } }); try {
      assert.match(await s.text('opencode_session_rename', { id: 'ses_030', title: 'A/b: line1\nline2\t x\u0000' }), /title is now: A\/b: line1 line2 x$/m);
      const t = await s.text('opencode_session_rename', { id: 'ses_031', title: 'T/x: ' + 'y'.repeat(300) }); assert.ok(t.split('\n')[0].length <= 'title is now: '.length + 200);
      const r = await s.call('opencode_session_rename', { id: '  ', title: 'A/b: c' }); assert.match(r.content[0].text, /id is required/);
      assert.match((await s.call('opencode_session_rename', { title: 'A/b: c' })).content[0].text, /id is required/);
    } finally { s.close(); }
  });
});

describe('protocol robustness', () => {
  test('odd `arguments` values are treated as an empty object', async () => {
    const s = startServer(); try { for (const a of [[], 'x', null, 7, undefined]) { const r = (await s.rpc('tools/call', { name: 'opencode_list', arguments: a })).result; assert.equal(r.content[0].text, 'none'); } } finally { s.close(); }
  });
  test('missing name / missing params / unknown tool -> isError, no crash', async () => {
    const s = startServer(); try {
      for (const p of [{}, { name: null }, undefined, { name: 'nope' }]) { const r = (await s.rpc('tools/call', p)).result; assert.equal(r.isError, true); assert.match(r.content[0].text, /unknown tool/); }
      assert.deepEqual((await s.rpc('ping')).result, {});
    } finally { s.close(); }
  });
  test('string and zero ids are echoed; null / missing ids are notifications', async () => {
    const s = startServer(); try {
      const got = []; s.child.stdout.on('data', (d) => got.push(String(d)));
      s.raw(JSON.stringify({ jsonrpc: '2.0', id: 'abc', method: 'ping' }) + '\n'); s.raw(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }) + '\n'); s.raw(JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }) + '\n'); s.raw(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }) + '\n');
      await waitFor(() => got.join('').split('\n').filter(Boolean).length >= 2); await sleep(150); const msgs = got.join('').split('\n').filter(Boolean).map(JSON.parse);
      assert.deepEqual(msgs.map((m) => m.id).sort(), [0, 'abc'].sort());
    } finally { s.close(); }
  });
  test('a 2 MB junk line and non-object JSON lines are ignored', async () => {
    const s = startServer(); try { s.raw('x'.repeat(2_000_000) + '\n'); s.raw('[1,2,3]\n'); s.raw('"str"\n'); s.raw('42\n'); s.raw('null\n'); assert.deepEqual((await s.rpc('ping')).result, {}); assert.equal(s.stderr, ''); } finally { s.close(); }
  });
  test('concurrent calls are answered independently', async () => {
    const s = startServer(); try { const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => s.text(i % 2 ? 'opencode_policy' : 'opencode_sessions', i % 2 ? {} : { limit: 3 }))); assert.ok(rs.every((r, i) => (i % 2 ? /^ACTIVE MODE/ : /^3 session\(s\)/).test(r))); } finally { s.close(); }
  });
  test('tool replies are capped at 100000 characters', async () => {
    const s = startServer({ env: { ...FAST, FAKE_BIGOUT: '3' } }); try { const id = tid(await s.text('opencode_start', { tier: 'easy', prompt: 'p' })); await final(s, id, /^done/); const t = await s.text('opencode_result', { id, tail: 1_999_999 }); assert.ok(t.length <= 100_300); } finally { s.close(); }
  });
});

describe('process table without /proc (macOS-style fallback)', () => {
  const dir = tmp(); const stub = buildStub(dir); const t = { skip: stub ? false : 'no C compiler' };
  test('titles with spaces are recovered up to the next flag; a note explains the approximation', t, async () => {
    const c = spawn(stub, ['run', '--title', 'LANE/explorer: has several spaces', '--agent', 'explorer', '--auto', 'msg'], { env: { ...process.env, STUB_SECONDS: '20' }, stdio: 'ignore' });
    const s = startServer({ env: { OPENCODE_BRIDGE_PROCFS: '0' } }); try {
      const text = await waitFor(async () => { const x = await s.text('opencode_processes'); return x.includes(String(c.pid)) && x; }, 5000);
      const row = lines(text).find((l) => l.includes(String(c.pid))); assert.match(row, /run\s+explorer\s/); assert.ok(row.endsWith('LANE/explorer: has several spaces'), row); assert.match(text, /\(no \/proc on this system: titles with spaces and working directories are approximate or missing\)$/);
    } finally { c.kill(); s.close(); }
  });
});
