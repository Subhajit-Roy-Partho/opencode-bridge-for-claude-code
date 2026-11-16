// v0.6: client-side timeouts, bridge / client restarts, interrupted-session recovery, the step-limit (tool_choice) failure,
// cancellation through the service, stale detection. Offline: fake opencode with a simulated service (FAKE_SVC), see test/bin/opencode.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync, statSync, rmSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { startServer, tmp, readLog, waitFor, sleep, HERE } from './helpers.mjs';

const FAST = { OPENCODE_BRIDGE_RETRY_DELAY_S: '0', OPENCODE_BRIDGE_KILL_GRACE_MS: '100', OPENCODE_BRIDGE_TIMEOUT_UNIT_MS: '100', OPENCODE_BRIDGE_REATTACH_POLL_MS: '100', OPENCODE_BRIDGE_REATTACH_QUIET_S: '0.3', OPENCODE_BRIDGE_WAIT_POLL_MS: '50' };
const tid = (t) => t.match(/task (\w{8}) started/)[1];
const runs = (f) => readLog(f).filter((l) => l.argv[0] === 'run');
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const taskJson = (s, id) => { const d = join(s.stateDir, 'tasks', id); const t = JSON.parse(readFileSync(join(d, 'task.json'), 'utf8')); try { t.runner = JSON.parse(readFileSync(join(d, 'runner.json'), 'utf8')); } catch {} return t; };
const killPid = (pid, sig) => { try { process.kill(Number(pid), sig); } catch {} };
async function begin(env, args = {}, srvOpts = {}) {
  const f = join(tmp(), 'log'); const svc = join(tmp(), 'svc'); const s = startServer({ env: { ...FAST, FAKE_LOG: f, FAKE_SVC: svc, ...env }, ...srvOpts });
  const t = await s.text('opencode_start', { tier: 'easy', prompt: 'task', agent: 'explorer', ...args });
  return { s, f, svc, id: tid(t), reply: t };
}
const final = (s, id, re = /^(done|failed|timeout|cancelled|interrupted|lost)/) => waitFor(async () => { const x = await s.text('opencode_status', { id }); return re.test(x) && x; }, 15000, 50);

describe('bounded waits: no call blocks past the client timeout', () => {
  test('opencode_result wait_s: a slow job answers still_running with progress and a next-poll hint, within the wait', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '5' }); try {
      const t0 = Date.now(); const r = await s.text('opencode_result', { id, wait_s: 1 }); const dt = Date.now() - t0;
      assert.ok(dt >= 900 && dt < 2500, `waited ${dt} ms`);
      assert.match(r, /^\[still_running\] task \w{8} is running after waiting 1 s/); assert.match(r, /\nprogress: \d+s elapsed, 1 step\(s\), last tool read\(\{"path":"docs\/"\}\)/); assert.match(r, /Next: poll again with opencode_result id=\w{8} wait_s=25/); assert.match(r, /opencode_session_output id=ses_svc/);
    } finally { s.close(); }
  });
  test('wait_s is capped (OPENCODE_BRIDGE_MAX_WAIT_S) and returns as soon as the task finishes', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '6', OPENCODE_BRIDGE_MAX_WAIT_S: '1' }); try {
      const t0 = Date.now(); const r = await s.text('opencode_result', { id, wait_s: 9999 }); assert.ok(Date.now() - t0 < 2500); assert.match(r, /^\[still_running\].*after waiting 1 s.*wait_s=1 /s);
    } finally { s.close(); }
    const q = await begin({ FAKE_SLEEP: '1' }); try {
      const t0 = Date.now(); const r = await q.s.text('opencode_result', { id: q.id, wait_s: 20 }); assert.ok(Date.now() - t0 < 6000, 'returns at the end of the job, not at wait_s'); assert.match(r, /^\[done\]\nhello world$/);
      const st = await q.s.text('opencode_status', { id: q.id, wait_s: 1 }); assert.match(st, /^done /);
    } finally { q.s.close(); }
  });
  test('opencode_start wait_s returns the outcome of a quick job in the same call, and still_running otherwise', async () => {
    const s = startServer({ env: { ...FAST, FAKE_SVC: join(tmp(), 'svc'), FAKE_SLEEP: '0' } }); try {
      const r = await s.text('opencode_start', { tier: 'easy', prompt: 'quick', agent: 'explorer', wait_s: 10 }); assert.match(r, /^task \w{8} started/); assert.match(r, /\ndone \(/); assert.match(r, /\n\[done\]\nhello world$/);
    } finally { s.close(); }
    const q = startServer({ env: { ...FAST, FAKE_SVC: join(tmp(), 'svc'), FAKE_SLEEP: '5' } }); try {
      const r = await q.text('opencode_start', { tier: 'easy', prompt: 'slow', agent: 'explorer', wait_s: 1 }); assert.match(r, /\n\[still_running\] task/);
    } finally { q.close(); }
  });
  test('a call that carries a progressToken gets MCP progress notifications while it waits', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '3', OPENCODE_BRIDGE_PROGRESS_MS: '100' }); try {
      const r = await s.rpc('tools/call', { name: 'opencode_result', arguments: { id, wait_s: 1 }, _meta: { progressToken: 'tok-1' } }); assert.match(r.result.content[0].text, /^\[still_running\]/);
      const pr = s.extra.filter((m) => m.method === 'notifications/progress'); assert.ok(pr.length >= 3, `${pr.length} notifications`); assert.ok(pr.every((m) => m.params.progressToken === 'tok-1'));
      const n = pr.map((m) => m.params.progress); assert.deepEqual(n, [...n].sort((a, b) => a - b)); assert.equal(new Set(n).size, n.length, 'progress strictly increases'); assert.match(pr.at(-1).params.message, /running: \d+s elapsed/);
    } finally { s.close(); }
    const s2 = startServer({ env: FAST }); try { await s2.call('opencode_list'); assert.equal(s2.extra.filter((m) => m.method === 'notifications/progress').length, 0, 'no token, no notifications'); } finally { s2.close(); }
  });
  test('a call never blocks longer than the bridge budget: a hung service gives a clear error with the budget', async () => {
    const s = startServer({ env: { ...FAST, OPENCODE_BRIDGE_CALL_BUDGET_S: '0.6', FAKE_API_SLEEP: '3000', OPENCODE_BRIDGE_API_TIMEOUT_MS: '5000' } }); try {
      const t0 = Date.now(); const r = await s.call('opencode_sessions', { limit: 5 }); assert.ok(Date.now() - t0 < 2000); assert.equal(r.isError, true);
      assert.match(r.content[0].text, /opencode_sessions did not finish within the bridge's 0\.6 s budget .*Nothing is lost: running tasks continue/);
    } finally { s.close(); }
  });
  test('notifications/cancelled from the client ends a wait early', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '8', OPENCODE_BRIDGE_MAX_WAIT_S: '20' }); try {
      const p = s.rpc('tools/call', { name: 'opencode_result', arguments: { id, wait_s: 20 } }); const t0 = Date.now(); await sleep(400);
      s.notify('notifications/cancelled', { requestId: 2 }); // the helper numbers its requests 1, 2, ...: this is the in-flight call (id 2: initialize was not sent, start was 1)
      const r = await p; assert.ok(Date.now() - t0 < 3000, `ended after ${Date.now() - t0} ms`); assert.match(r.result.content[0].text, /^\[still_running\]/);
    } finally { s.close(); }
  });
  test('no tool can block: status / list / policy / cancel answer immediately for a running task', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '10' }); try {
      for (const [n, a] of [['opencode_status', { id }], ['opencode_result', { id }], ['opencode_list', {}], ['opencode_policy', {}]]) { const t0 = Date.now(); await s.text(n, a); assert.ok(Date.now() - t0 < 1000, n); }
    } finally { s.close(); }
  });
});

describe('restarts: tasks are detached and registered on disk', () => {
  test('a task started by one bridge instance finishes while no bridge is running and is read by the next one', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '1' }, { agent: 'worker' }); const state = s.stateDir, root = s.rootDir;
    const f = join(state, 'tasks', id); assert.equal((statSync(state).mode & 0o777).toString(8), '700'); assert.equal((statSync(join(f, 'prompt.md')).mode & 0o777).toString(8), '600'); assert.equal((statSync(join(f, 'task.json')).mode & 0o777).toString(8), '600');
    s.child.stdin.end(); await sleep(1800); // the bridge is gone, the job ends on its own
    const s2 = startServer({ env: { ...FAST, OPENCODE_BRIDGE_STATE_DIR: state, OPENCODE_BRIDGE_ROOT: root } }); try {
      assert.match(await s2.text('opencode_status', { id }), /^done \(\d+s, 11 chars, session ses_fake01\) worker\/easy\/blueprint/); assert.match(await s2.text('opencode_result', { id }), /^\[done\]\nhello world$/);
      assert.match(await s2.text('opencode_list'), new RegExp(`${id} done .* \\[earlier bridge instance\\]`));
    } finally { s2.close(); s.close(); }
  });
  test('the opencode client is detached from the bridge: it has its own process group and its stdout is a file', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '30' }, { agent: 'worker' }); try {
      const j = await waitFor(() => { try { const t = taskJson(s, id); return t.child && t; } catch { return null; } }); const bridgePgid = Number(readFileSync(`/proc/${s.child.pid}/stat`, 'utf8').split(') ')[1].split(' ')[2]);
      const pg = (pid) => Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[2]);
      assert.equal(pg(j.child.pid), j.child.pid, 'client leads its own process group'); assert.equal(pg(j.runner.pid), j.runner.pid, 'runner leads its own group'); assert.notEqual(pg(j.child.pid), bridgePgid);
      assert.match(readFileSync(`/proc/${j.child.pid}/cmdline`, 'utf8'), /opencode/); await waitFor(() => readFileSync(join(s.stateDir, 'tasks', id, 'out.1.jsonl'), 'utf8').includes('step_start'));
    } finally { s.close(); }
  });
  test('the runner enforces the stored deadline and the per-task timeout survives a bridge restart', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '30' }, { agent: 'worker', timeout_minutes: 4 }); const state = s.stateDir, root = s.rootDir; // 4 x 100 ms
    s.child.stdin.end(); const s2 = startServer({ env: { ...FAST, OPENCODE_BRIDGE_STATE_DIR: state, OPENCODE_BRIDGE_ROOT: root } }); try {
      assert.match(await final(s2, id), /^timeout \(timeout\)/); assert.match(await s2.text('opencode_result', { id }), /^\[timeout: timeout\]\nno result after 400 ms/);
    } finally { s2.close(); s.close(); }
  });
  test('supervisor killed, client alive: shown as running with a note; the bridge enforces the deadline itself', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '30' }, { agent: 'worker', timeout_minutes: 15 }); try {
      const j = await waitFor(() => { try { const t = taskJson(s, id); return t.child && t; } catch { return null; } });
      killPid(j.runner.pid, 'SIGKILL'); await waitFor(() => !alive(j.runner.pid), 3000, 30);
      assert.match(await s.text('opencode_status', { id }), /^running .*\[supervisor process gone, the run continues\]/);
      assert.match(await final(s, id), /^timeout/); await waitFor(() => !alive(j.child.pid), 3000, 50);
      assert.equal(taskJson(s, id).status, 'timeout');
    } finally { s.close(); }
  });
  test('runner AND client gone without a final record: ask the service. Session finished -> done with the text from the session', async () => {
    const { s, id, svc } = await begin({ FAKE_SLEEP: '1.5', FAKE_SVC_TEXT: 'FINAL FROM SERVICE' }); try {
      const j = await waitFor(() => { try { const t = taskJson(s, id); return t.sessionID && t.child && t; } catch { return null; } });
      killPid(j.runner.pid, 'SIGKILL'); killPid(j.child.pid, 'SIGKILL'); await waitFor(() => !alive(j.runner.pid) && !alive(j.child.pid), 3000, 30);
      assert.match(await s.text('opencode_status', { id }), /^running /, 'the service still runs the session'); // not lost, not failed
      assert.match(await final(s, id, /^done/), /^done /); assert.match(await s.text('opencode_result', { id }), /^\[done\]\nFINAL FROM SERVICE$/);
    } finally { s.close(); }
  });
  test('runner AND client gone, session interrupted in the service -> interrupted (recoverable), not failed', async () => {
    const { s, id, svc } = await begin({ FAKE_SLEEP: '1', FAKE_SVC_OUTCOME: 'interrupted' }); try {
      const j = await waitFor(() => { try { const t = taskJson(s, id); return t.sessionID && t.child && t; } catch { return null; } });
      killPid(j.runner.pid, 'SIGKILL'); killPid(j.child.pid, 'SIGKILL'); await waitFor(() => !alive(j.runner.pid) && !alive(j.child.pid), 3000, 30);
      assert.match(await final(s, id, /^interrupted/), /^interrupted \(interrupted\)/);
      const r = await s.text('opencode_result', { id }); assert.match(r, /^\[interrupted: interrupted\]\nthe session was interrupted in the service\nAdvice: The run was stopped before it reported an outcome/); assert.match(r, /\nrecoverable: yes, read-only agent: opencode_resume id=\w{8}/);
    } finally { s.close(); }
  });
  test('a task with no session and no live process is "lost"; one whose session vanished is "lost" too', async () => {
    const s = startServer({ env: FAST }); try {
      mkdirSync(join(s.stateDir, 'tasks'), { recursive: true });
      const mk = (id, extra) => { const d = join(s.stateDir, 'tasks', id); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'task.json'), JSON.stringify({ v: 1, id, status: 'running', started: Date.now() - 60000, deadline: Date.now() + 3600000, timeoutMs: 3600000, mode: 'blueprint', agent: 'explorer', tier: 'easy', title: 'X/explorer: t', cwd: s.rootDir, backend: 'service', attempt: 1, runner: { pid: 2147483000, start: '1' }, child: { pid: 2147483001, start: '1' }, ...extra })); };
      mk('aaaaaaaa', {}); mk('bbbbbbbb', { sessionID: 'ses_svcgone' });
      const a = await s.text('opencode_result', { id: 'aaaaaaaa' }); assert.match(a, /^\[lost: lost\]\nthe run ended before opencode created a session/); assert.match(a, /recoverable: no session exists/);
      assert.match(await s.text('opencode_result', { id: 'bbbbbbbb' }), /^\[lost: lost\]\nsession ses_svcgone no longer exists in the service/);
      assert.match(await s.text('opencode_status', { id: 'aaaaaaaa' }), /^lost \(lost\)/);
    } finally { s.close(); }
  });
  test('old finished task directories are pruned at start-up, recent and live ones are kept', async () => {
    const s0 = startServer({ env: FAST }); const state = s0.stateDir, root = s0.rootDir; s0.close();
    const mk = (id, st, ended) => { const d = join(state, 'tasks', id); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'task.json'), JSON.stringify({ v: 1, id, status: st, started: ended - 1000, ended, deadline: Date.now() + 1e9, timeoutMs: 1e9, mode: 'blueprint', agent: 'worker', tier: 'easy', title: 'X/worker: t', cwd: root, backend: 'standalone', attempt: 1 })); };
    mk('0000000a', 'done', Date.now() - 20 * 86400000); mk('0000000b', 'done', Date.now() - 3600000);
    const s = startServer({ env: { ...FAST, OPENCODE_BRIDGE_STATE_DIR: state, OPENCODE_BRIDGE_ROOT: root } }); try {
      await sleep(300); assert.ok(!existsSync(join(state, 'tasks', '0000000a'))); assert.ok(existsSync(join(state, 'tasks', '0000000b')));
    } finally { s.close(); }
  });
});

describe('interrupted sessions: classified apart from failures, resumable', () => {
  test('a client that gets SIGTERM (what the old shutdown did) interrupts the session: status interrupted, not failed, with advice', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '30' }); try {
      const j = await waitFor(() => { try { const t = taskJson(s, id); return t.sessionID && t.child && t; } catch { return null; } }); killPid(j.child.pid, 'SIGTERM');
      assert.match(await final(s, id), /^interrupted \(interrupted\)/); const r = await s.text('opencode_result', { id });
      assert.match(r, /^\[interrupted: interrupted\]\nsession interrupted: user|^\[interrupted: interrupted\]\naborted: Session interrupted: user/); assert.match(r, /recoverable: yes, read-only agent/); assert.match(r, /--- partial output ---\nhello $|\nhello $/);
      assert.ok(!/failed/.test(r.split('\n')[0]));
    } finally { s.close(); }
  });
  test('the client is SIGKILLed but the service keeps running the session: the runner re-attaches and the task ends done', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '1.5', FAKE_SVC_TEXT: 'ANSWER' }); try {
      const j = await waitFor(() => { try { const t = taskJson(s, id); return t.sessionID && t.child && t; } catch { return null; } }); killPid(j.child.pid, 'SIGKILL');
      assert.match(await final(s, id, /^done/), /^done /); const t = taskJson(s, id); assert.equal(t.reattached, true); assert.match(await s.text('opencode_result', { id }), /^\[done\]\nANSWER$/);
    } finally { s.close(); }
  });
  test('the client is SIGKILLed and the service then reports the session interrupted / failed: interrupted resp. failed (classified)', async () => {
    for (const [outcome, re] of [['interrupted', /^interrupted /], ['failed', /^failed \(rate_limit\)/]]) {
      const { s, id } = await begin({ FAKE_SLEEP: '1', FAKE_SVC_OUTCOME: outcome }); try {
        const j = await waitFor(() => { try { const t = taskJson(s, id); return t.sessionID && t.child && t; } catch { return null; } }); killPid(j.child.pid, 'SIGKILL'); assert.match(await final(s, id), re, outcome);
      } finally { s.close(); }
    }
  });
  test('a standalone client killed by a signal without any outcome is interrupted, not a mystery "signal" failure', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '30' }, { agent: 'worker' }); try {
      const j = await waitFor(() => { try { const t = taskJson(s, id); return t.child && t; } catch { return null; } }); killPid(j.child.pid, 'SIGKILL');
      assert.match(await final(s, id), /^interrupted \(interrupted\)/); assert.match(await s.text('opencode_result', { id }), /the opencode client was killed by SIGKILL before it reported an outcome/);
    } finally { s.close(); }
  });
  test('opencode_resume (read-only agent): a new task with the original prompt, the progress so far and a resume title', async () => {
    const { s, f, id } = await begin({ FAKE_SLEEP: '30' }, { prompt: 'ORIGINAL TASK TEXT for the explorer' }); try {
      const j = await waitFor(() => { try { const t = taskJson(s, id); return t.sessionID && t.child && t; } catch { return null; } }); await waitFor(async () => /hello/.test(await s.text('opencode_result', { id }))); killPid(j.child.pid, 'SIGTERM'); await final(s, id, /^interrupted/);
      const r = await s.text('opencode_resume', { id, note: 'be brief' }); assert.match(r, /^task (\w{8}) started/); assert.match(r, new RegExp(`Resumed task ${id} \\(interrupted\\) as \\w{8} in a new session`));
      const id2 = tid(r); assert.notEqual(id2, id);
      const rr = await waitFor(() => runs(f).length >= 2 && runs(f)[1]); const msg = rr.argv.at(-1);
      assert.ok(msg.includes('ORIGINAL TASK TEXT for the explorer')); assert.match(msg, /RESUME: an earlier run of this task \(id \w{8}, session ses_svc\w+\) ended as "interrupted"/); assert.match(msg, /Output of the earlier run \(last part\):\nhello/); assert.match(msg, /Its last steps:\n {2}read\(\{"path":"docs\/"\}\) \[completed\]/); assert.match(msg, /Extra instruction: be brief/);
      assert.match(rr.argv[rr.argv.indexOf('--title') + 1], /\/explorer: .*\(resume\)$/); assert.ok(!rr.argv.includes('-s'));
      assert.equal(taskJson(s, id2).resumeOf, id); const listed = await s.text('opencode_list'); assert.ok(listed.includes(id2));
    } finally { s.close(); }
  });
  test('opencode_resume same_session:true continues the same opencode session', async () => {
    const { s, f, id } = await begin({ FAKE_SLEEP: '30' }); try {
      const j = await waitFor(() => { try { const t = taskJson(s, id); return t.sessionID && t.child && t; } catch { return null; } }); killPid(j.child.pid, 'SIGTERM'); await final(s, id, /^interrupted/);
      const r = await s.text('opencode_resume', { id, same_session: true }); assert.match(r, /in the same session/); const rr = await waitFor(() => runs(f).length >= 2 && runs(f)[1]);
      assert.equal(rr.argv[rr.argv.indexOf('-s') + 1], j.sessionID); assert.ok(!rr.argv.includes('--title'));
    } finally { s.close(); }
  });
  test('opencode_resume refuses editing agents until acknowledge_edits:true, and shows git status of the working directory', async () => {
    const root = tmp(); spawnSync('git', ['init', '-q', root]); writeFileSync(join(root, 'half-done.txt'), 'partial edit by the interrupted run');
    const { s, f, id } = await begin({ FAKE_SLEEP: '30' }, { agent: 'fixer', prompt: 'EDIT THE FILES' }, { root }); try {
      const j = await waitFor(() => { try { const t = taskJson(s, id); return t.sessionID && t.child && t; } catch { return null; } }); killPid(j.child.pid, 'SIGTERM'); await final(s, id, /^interrupted/);
      assert.match(await s.text('opencode_result', { id }), /recoverable: partly: editing agent, check `git status` then opencode_resume id=\w{8} acknowledge_edits:true/);
      const refused = await s.call('opencode_resume', { id }); assert.equal(refused.isError, true); assert.match(refused.content[0].text, /used the EDITING agent "fixer"/); assert.match(refused.content[0].text, /\?\? half-done\.txt/); assert.match(refused.content[0].text, /acknowledge_edits:true/); assert.equal(runs(f).length, 1);
      const ok = await s.text('opencode_resume', { id, acknowledge_edits: true }); assert.match(ok, /Working tree at the time of the resume \(git status --short\):\n\?\? half-done\.txt/);
      const rr = await waitFor(() => runs(f).length >= 2 && runs(f)[1]); assert.match(rr.argv.at(-1), /PARTIAL EDITS of the earlier run\. Run `git status` and `git diff` first/); assert.ok(rr.argv.at(-1).includes('EDIT THE FILES'));
    } finally { s.close(); }
  });
  test('opencode_resume refuses running and finished tasks, unknown ids, and re-checks the delegation policy', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '30' }); try {
      assert.match((await s.call('opencode_resume', { id })).content[0].text, /is still running; nothing to resume/); assert.match((await s.call('opencode_resume', { id: 'ffffffff' })).content[0].text, /unknown task/);
    } finally { s.close(); }
    const d = await begin({ FAKE_SLEEP: '0' }); try { await final(d.s, d.id, /^done/); assert.match((await d.s.call('opencode_resume', { id: d.id })).content[0].text, /finished successfully/); } finally { d.s.close(); }
    const q = await begin({ FAKE_SLEEP: '30', OPENCODE_MODE: 'sensitive' }, { agent: 'explorer' }); try {
      const j = await waitFor(() => { try { const t = taskJson(q.s, q.id); return t.child && t; } catch { return null; } }); killPid(j.child.pid, 'SIGTERM'); await final(q.s, q.id, /^interrupted/);
      assert.match(await q.s.text('opencode_resume', { id: q.id }), /^task \w{8} started \| mode=sensitive/);
    } finally { q.s.close(); }
  });
  test('opencode_sessions / session_output: interrupted is its own state with an explanation', async () => {
    const s = startServer({ env: FAST }); try { const t = await s.text('opencode_session_output', { id: 'ses_008' }); assert.match(t, /^ses_008  interrupted /); assert.match(t, /note: interrupted = stopped before it finished/); assert.match(await s.text('opencode_sessions', { state: 'interrupted', limit: 3 }), /interrupted/); } finally { s.close(); }
  });
});

describe('the step limit failure (provider error tool_choice)', () => {
  const TC = { FAKE_ERR_TYPE: 'provider.invalid-request', FAKE_ERR_MSG: 'only `"auto"` is supported for `tool_choice`. `"none"`, `"required"`, and named function choices are not currently supported' };
  test('classified as step_limit with the root cause in the advice', async () => {
    const f = join(tmp(), 'l'); const s = startServer({ env: { ...FAST, ...TC, FAKE_LOG: f } }); try {
      const id = tid(await s.text('opencode_start', { tier: 'easy', prompt: 'x', agent: 'worker' })); await final(s, id);
      const r = await s.text('opencode_result', { id }); assert.match(r, /^\[failed: step_limit\]/); assert.match(r, /Advice: The provider rejected a forced `tool_choice`\. This is what happens when an agent reaches its `steps` limit/); assert.equal(runs(f).length, 1, 'editing agent: no automatic fallback');
    } finally { s.close(); }
  });
  test('read-only agent: one automatic fallback asks for the report in the same session (no more tools), and says so', async () => {
    const f = join(tmp(), 'l'), cf = join(tmp(), 'c'); const s = startServer({ env: { ...FAST, ...TC, FAKE_LOG: f, FAKE_FAIL_TIMES: '1', FAKE_COUNT_FILE: cf } }); try {
      const id = tid(await s.text('opencode_start', { tier: 'easy', prompt: 'x', agent: 'explorer' })); const st = await final(s, id);
      assert.match(st, /^done \(\d+s, 11 chars, session ses_fake01, attempt 2\) explorer\/easy\/blueprint \[fallback: finalize-in-session\]/);
      const r = runs(f); assert.equal(r.length, 2); assert.ok(!r[0].argv.includes('-s')); assert.equal(r[1].argv[r[1].argv.indexOf('-s') + 1], 'ses_fake01'); assert.ok(!r[1].argv.includes('--title')); assert.match(r[1].argv.at(-1), /Do NOT call any more tools\. Write your final report NOW/); assert.match(r[1].argv.at(-1), /READ-ONLY/);
      const res = await s.text('opencode_result', { id }); assert.match(res, /^\[done\]\nfallback used: finalize-in-session \(attempt 1 hit the step limit/);
    } finally { s.close(); }
  });
  test('if the fallback fails as well, the task fails (step_limit), after exactly two runs', async () => {
    const f = join(tmp(), 'l'); const s = startServer({ env: { ...FAST, ...TC, FAKE_LOG: f } }); try {
      const id = tid(await s.text('opencode_start', { tier: 'easy', prompt: 'x', agent: 'librarian' })); assert.match(await final(s, id), /^failed \(step_limit\)/); await sleep(200); assert.equal(runs(f).length, 2);
    } finally { s.close(); }
  });
  test('a retry never replays a task that produced output; the fallback needs a session id', async () => {
    const f = join(tmp(), 'l'); const s = startServer({ env: { ...FAST, ...TC, FAKE_LOG: f, FAKE_FAIL_TIMES: '1', FAKE_COUNT_FILE: join(tmp(), 'c'), FAKE_TEXT_FIRST: '1' } }); try {
      const id = tid(await s.text('opencode_start', { tier: 'easy', prompt: 'x', agent: 'oracle' })); assert.match(await final(s, id), /^done .*\[fallback: finalize-in-session\]/); assert.equal(runs(f).length, 2);
    } finally { s.close(); }
  });
});

describe('cancel through the service', () => {
  test('opencode_cancel on a service task: POST .../interrupt, client stopped, task and session show as cancelled (not interrupted)', async () => {
    const { s, f, id } = await begin({ FAKE_SLEEP: '30' }); try {
      const j = await waitFor(() => { try { const t = taskJson(s, id); return t.sessionID && t.child && t; } catch { return null; } });
      const r = await s.text('opencode_cancel', { id }); assert.match(r, /^cancelled\nsession ses_svc\w+ interrupted through the service$/);
      assert.ok(readLog(f).some((l) => l.method === 'POST' && l.path === `/api/session/${j.sessionID}/interrupt`));
      assert.match(await final(s, id), /^cancelled/); await waitFor(() => !alive(j.child.pid), 3000, 50); assert.equal(taskJson(s, id).status, 'cancelled');
      const out = await s.text('opencode_session_output', { id: j.sessionID }); assert.match(out, /^ses_svc\w+  cancelled /); assert.match(out, /note: cancelled through the bridge/);
      assert.match(await s.text('opencode_sessions', { state: 'cancelled' }), /cancelled/); assert.ok(!(await s.text('opencode_sessions', { state: 'interrupted' })).includes(j.sessionID));
    } finally { s.close(); }
  });
  test('opencode_cancel with a session id that no bridge task owns: interrupted through the service, listed as cancelled', async () => {
    const svc = join(tmp(), 'svc'); const f = join(tmp(), 'l'); const s = startServer({ env: { ...FAST, FAKE_SVC: svc, FAKE_LOG: f, FAKE_SLEEP: '30' } }); try {
      // a session started outside the bridge: run the fake directly, as `opencode run` in another lane would
      const bin = join(HERE, 'bin', 'opencode');
      const p = spawn(bin, ['run', '--agent', 'explorer', '--title', 'OTHER/explorer: elsewhere', 'go'], { env: { ...process.env, FAKE_SVC: svc, FAKE_SLEEP: '30' }, stdio: 'ignore', detached: true }); p.unref();
      const sid = await waitFor(() => existsSync(svc) && require_ls(svc)[0]?.replace('.json', '')); const r = await s.text('opencode_cancel', { id: sid });
      assert.match(r, new RegExp(`^cancelled: session ${sid} interrupted through the service \\(service outcome: interrupted`)); assert.match(await s.text('opencode_sessions', { state: 'cancelled' }), new RegExp(sid));
      await waitFor(() => !alive(p.pid), 3000, 50);
      assert.match(await s.text('opencode_cancel', { id: sid }), /the service has no active execution to interrupt/);
    } finally { s.close(); }
  });
  test('cancelling a retrying task does not call the service; cancelling twice says so; a finished task says so', async () => {
    const { s, f, id } = await begin({ FAKE_SLEEP: '30' }); try {
      assert.match(await s.text('opencode_cancel', { id }), /^cancelled/); assert.equal(await s.text('opencode_cancel', { id }), 'task already cancelled; nothing to cancel'); await final(s, id, /^cancelled/); assert.equal(await s.text('opencode_cancel', { id }), 'task already cancelled; nothing to cancel');
    } finally { s.close(); }
  });
  test('cancel works from another bridge instance (the runner stops, the final state is cancelled)', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '30' }); const state = s.stateDir, root = s.rootDir;
    const s2 = startServer({ env: { ...FAST, FAKE_SVC: join(tmp(), 'svc2'), OPENCODE_BRIDGE_STATE_DIR: state, OPENCODE_BRIDGE_ROOT: root } }); try {
      const j = await waitFor(() => { try { const t = taskJson(s, id); return t.child && t; } catch { return null; } }); assert.match(await s2.text('opencode_cancel', { id }), /^cancelled/); await waitFor(() => !alive(j.child.pid) && !alive(j.runner.pid), 4000, 50); assert.match(await s.text('opencode_status', { id }), /^cancelled/);
    } finally { s2.close(); s.close(); }
  });
});

describe('stale detection and limits keep working', () => {
  test('a running task whose output has been quiet for > 45 min is flagged stale?', async () => {
    const { s, id } = await begin({ FAKE_SLEEP: '30' }); try {
      await waitFor(() => existsSync(join(s.stateDir, 'tasks', id, 'out.1.jsonl'))); const old = new Date(Date.now() - 50 * 60000); utimesSync(join(s.stateDir, 'tasks', id, 'out.1.jsonl'), old, old);
      assert.match(await s.text('opencode_status', { id }), /^running .*\[stale\?: no output for 50 min\]/); assert.match(await s.text('opencode_result', { id }), /progress: .*\[stale\?: no output for 50 min\]/);
    } finally { s.close(); }
  });
  test('opencode_sessions with 130 sessions and the stale / cancelled states are unchanged; replies stay capped', async () => {
    const s = startServer({ env: FAST }); try { const t = await s.text('opencode_sessions', { limit: 200 }); assert.match(t, /^130 session\(s\)/); assert.ok(t.length <= 100_300); assert.match(await s.text('opencode_sessions', { state: 'stale' }), /^1 session\(s\)/); } finally { s.close(); }
  });
});

function require_ls(dir) { return spawnSync('ls', [dir], { encoding: 'utf8' }).stdout.split('\n').filter((x) => x.endsWith('.json')); }
