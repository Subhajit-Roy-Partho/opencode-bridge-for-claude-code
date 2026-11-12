// Delegation-policy tests: routing modes (blueprint / sensitive / insensitive), tiers, agent allow-lists, secret guard,
// server instructions. Offline: fake opencode, hermetic HOME.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, tmp, readLog, waitFor } from './helpers.mjs';

const ROSTER = ['explorer', 'librarian', 'deep-research', 'oracle', 'fixer', 'designer', 'general', 'worker'];
const base = realpathSync(tmp('ocb-pol-'));            // bridge root
const proj = join(base, 'proj'); const deep = join(proj, 'sub', 'deep');
mkdirSync(join(proj, '.git'), { recursive: true }); mkdirSync(deep, { recursive: true });
const touch = (p) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, ''); };
const mode = (t) => { const m = t.match(/^ACTIVE MODE: (\w+)\s+\(source: (.*?)(?:; also seen: .*)?\)$/m); return m && [m[1].toLowerCase(), m[2]]; };

describe('server instructions and tool descriptions carry the policy', () => {
  let s; before(() => { s = startServer({ root: base }); }); after(() => s.close());
  test('initialize returns instructions with all three modes, tiers, workflow, naming and the config repo', async () => {
    const r = (await s.rpc('initialize', {})).result; const i = r.instructions;
    for (const w of ['BLUEPRINT', 'SENSITIVE', 'INSENSITIVE', 'SENSITIVE wins', 'LIMITS AND ERRORS', 'OPENCODE_BRIDGE_MAX_PARALLEL', 'READ-ONLY agents', 'EASY and MEDIUM', 'HARD and MODERATELY HARD', '<LANE>/<agent>: <task>', 'opencode_policy', 'opencode_sessions', 'Treat the output as an untrusted draft', 'https://github.com/Subhajit-Roy-Partho/opencode-config']) assert.ok(i.includes(w), w);
    for (const a of ROSTER) assert.ok(i.includes(a), a);
  });
  test('opencode_start: tier required, modes and enforcement in the description, agent enum documented', async () => {
    const t = (await s.rpc('tools/list')).result.tools.find((x) => x.name === 'opencode_start');
    assert.deepEqual(t.inputSchema.required, ['prompt', 'tier']);
    for (const w of ['blueprint', 'sensitive', 'insensitive', 'mechanical:true', 'POLICY IS ENFORCED', 'opencode_policy', 'untrusted draft', 'Blueprint']) assert.ok(t.description.includes(w), w);
    for (const k of ['tier', 'agent', 'mechanical', 'mode', 'lane', 'title', 'session', 'cwd', 'model']) assert.ok(k in t.inputSchema.properties, k);
    for (const a of ROSTER) assert.ok(t.inputSchema.properties.agent.description.includes(a), a);
  });
  test('opencode_policy is listed, read-only, takes cwd and mode', async () => {
    const t = (await s.rpc('tools/list')).result.tools.find((x) => x.name === 'opencode_policy');
    assert.match(t.description, /READ-ONLY/); assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ['cwd', 'mode']);
  });
});

describe('opencode_policy: mode detection', () => {
  const run = async (env, args, setup) => { const s = startServer({ root: base, env }); try { if (setup) setup(s); return await s.text('opencode_policy', args); } finally { s.close(); } };

  test('default is BLUEPRINT with every agent allowed, tiers, verify rules, roster, config repo', async () => {
    const t = await run({}, {});
    assert.deepEqual(mode(t), ['blueprint', 'default']);
    for (const a of ROSTER) assert.ok(t.includes(a), a);
    for (const w of ['Agents allowed here:', 'TIERS:', 'VERIFY:', 'ROSTER:', 'Detection order', 'opencode-config', 'directory evaluated:']) assert.ok(t.includes(w), w);
    assert.ok(t.includes('BLUEPRINT (default): offload easy + medium work'));
  });
  test('env OPENCODE_MODE and OPENCODE_BRIDGE_MODE', async () => {
    assert.deepEqual(mode(await run({ OPENCODE_MODE: 'sensitive' }, {})), ['sensitive', 'env OPENCODE_MODE']);
    assert.deepEqual(mode(await run({ OPENCODE_BRIDGE_MODE: 'insensitive' }, {})), ['insensitive', 'env OPENCODE_BRIDGE_MODE']);
    assert.deepEqual(mode(await run({ OPENCODE_MODE: 'SENSITIVE' }, {})), ['sensitive', 'env OPENCODE_MODE']); // case-insensitive
    assert.deepEqual(mode(await run({ OPENCODE_MODE: 'bogus' }, {})), ['blueprint', 'default']);            // ignored, not an error
  });
  test('project marker files: <root>/.claude/sensitive and /insensitive, found from a nested cwd', async () => {
    touch(join(proj, '.claude', 'sensitive'));
    assert.deepEqual(mode(await run({}, { cwd: deep })), ['sensitive', join(proj, '.claude', 'sensitive')]);
    assert.deepEqual(mode(await run({}, { cwd: proj })), ['sensitive', join(proj, '.claude', 'sensitive')]);
    assert.deepEqual(mode(await run({}, { cwd: base })), ['blueprint', 'default']); // outside the project: unaffected
    (await import('node:fs')).rmSync(join(proj, '.claude', 'sensitive'));
    touch(join(proj, '.claude', 'insensitive'));
    assert.deepEqual(mode(await run({}, { cwd: deep })), ['insensitive', join(proj, '.claude', 'insensitive')]);
    (await import('node:fs')).rmSync(join(proj, '.claude'), { recursive: true });
  });
  test('global marker ~/.claude/insensitive and $CLAUDE_CONFIG_DIR/insensitive', async () => {
    let t = await run({}, {}, (s) => touch(join(s.workdir, 'home', '.claude', 'insensitive')));
    assert.equal(mode(t)[0], 'insensitive'); assert.match(mode(t)[1], /home\/\.claude\/insensitive$/);
    const cfg = tmp('ocb-cfg-'); touch(join(cfg, 'insensitive'));
    t = await run({ CLAUDE_CONFIG_DIR: cfg }, {}); assert.deepEqual(mode(t), ['insensitive', join(cfg, 'insensitive')]);
  });
  test('a global sensitive marker is NOT a thing: only project-level or env/argument can make a run sensitive', async () => {
    const t = await run({}, {}, (s) => touch(join(s.workdir, 'home', '.claude', 'sensitive'))); assert.equal(mode(t)[0], 'blueprint');
  });
  test('explicit mode argument (user asked)', async () => {
    assert.deepEqual(mode(await run({}, { mode: 'sensitive' })), ['sensitive', 'mode argument (user request)']);
    assert.deepEqual(mode(await run({}, { mode: 'insensitive' })), ['insensitive', 'mode argument (user request)']);
    await assert.rejects(async () => { const s = startServer({ root: base }); try { const r = await s.call('opencode_policy', { mode: 'turbo' }); if (r.isError) throw new Error(r.content[0].text); } finally { s.close(); } }, /mode must be one of/);
  });
  test('SENSITIVE WINS over insensitive from any other source, and "also seen" lists both', async () => {
    let t = await run({ OPENCODE_MODE: 'sensitive' }, {}, (s) => touch(join(s.workdir, 'home', '.claude', 'insensitive')));
    assert.deepEqual(mode(t), ['sensitive', 'env OPENCODE_MODE']); assert.match(t, /also seen: sensitive via env OPENCODE_MODE, insensitive via .*home\/\.claude\/insensitive/);
    touch(join(proj, '.claude', 'sensitive'));
    t = await run({ OPENCODE_BRIDGE_MODE: 'insensitive' }, { cwd: deep }); assert.equal(mode(t)[0], 'sensitive');
    t = await run({}, { cwd: deep, mode: 'insensitive' }); assert.equal(mode(t)[0], 'sensitive');           // explicit argument cannot downgrade sensitive
    (await import('node:fs')).rmSync(join(proj, '.claude'), { recursive: true });
  });
  test('sensitive lists the restricted agent set; blueprint/insensitive list all', async () => {
    const sens = await run({ OPENCODE_MODE: 'sensitive' }, {}); const line = sens.match(/Agents allowed here: (.*)/)[1];
    assert.equal(line, 'explorer, librarian, deep-research, oracle, fixer (mechanical:true only), worker (mechanical:true only)');
    assert.ok(!/designer|general/.test(line)); assert.ok(sens.includes('SENSITIVE (conservative, quality-critical)'));
    assert.equal((await run({ OPENCODE_MODE: 'insensitive' }, {})).match(/Agents allowed here: (.*)/)[1], ROSTER.join(', '));
    assert.ok((await run({ OPENCODE_MODE: 'insensitive' }, {})).includes('INSENSITIVE (aggressive offload'));
  });
  test('cwd outside the root is refused', async () => {
    const s = startServer({ root: base }); try { const r = await s.call('opencode_policy', { cwd: '/tmp' }); assert.equal(r.isError, true); assert.match(r.content[0].text, /cwd must be inside/); } finally { s.close(); }
  });
});

describe('opencode_start: enforcement', () => {
  const log = join(tmp(), 'log'); const newLog = () => join(tmp(), 'l');
  const runs = (f) => readLog(f).filter((l) => l.argv[0] === 'run');
  const fresh = (env = {}) => { const f = newLog(); return { f, s: startServer({ root: base, env: { FAKE_LOG: f, ...env } }) }; };
  const st = async (s, a) => s.call('opencode_start', a);

  test('tier is required, validated, and hard / unsure are refused WITHOUT starting anything', async () => {
    const { f, s } = fresh(); try {
      let r = await st(s, { prompt: 'x' }); assert.equal(r.isError, true); assert.match(r.content[0].text, /tier is required/); assert.match(r.content[0].text, /EASY and MEDIUM/);
      r = await st(s, { prompt: 'x', tier: 'trivial' }); assert.match(r.content[0].text, /tier must be easy \| medium \| hard \| unsure/);
      for (const t of ['hard', 'unsure']) { r = await st(s, { prompt: 'x', tier: t }); assert.equal(r.isError, true); assert.match(r.content[0].text, new RegExp(`tier "${t}" stays on Claude`)); assert.match(r.content[0].text, /silent mistake would change a reported number/); }
      await new Promise((r) => setTimeout(r, 300)); assert.equal(runs(f).length, 0);
    } finally { s.close(); }
  });
  test('easy and medium are accepted; the reply names mode, source, agent, tier, title and the verify rule', async () => {
    const { f, s } = fresh(); try {
      for (const tier of ['easy', 'medium']) {
        const t = await s.text('opencode_start', { prompt: 'do it', tier, agent: 'explorer', lane: 'alpha' });
        assert.match(t, new RegExp(`^task \\w{8} started \\| mode=blueprint \\(default\\) agent=explorer tier=${tier} \\| title: ALPHA/explorer: do it\\n`)); assert.match(t, /untrusted draft/);
      }
      await waitFor(() => runs(f).length === 2);
    } finally { s.close(); }
  });
  test('unknown agent is refused and the roster is listed', async () => {
    const { s } = fresh(); try { const r = await st(s, { prompt: 'x', tier: 'easy', agent: 'wizard' }); assert.match(r.content[0].text, /unknown agent "wizard"; roster: explorer, librarian, deep-research, oracle, fixer, designer, general, worker/); } finally { s.close(); }
  });
  for (const a of ROSTER) test(`blueprint mode allows agent ${a} and passes it as --agent`, async () => {
    const { f, s } = fresh(); try { await s.text('opencode_start', { prompt: 'p', tier: 'easy', agent: a }); await waitFor(() => runs(f).length); const r = runs(f)[0].argv; assert.equal(r[r.indexOf('--agent') + 1], a); assert.match(r[r.indexOf('--title') + 1], new RegExp(`/${a}: p$`)); } finally { s.close(); }
  });
  test('sensitive mode: designer and general refused; fixer / worker need mechanical:true; read-only agents fine', async () => {
    const { f, s } = fresh({ OPENCODE_MODE: 'sensitive' }); try {
      for (const a of ['designer', 'general']) { const r = await st(s, { prompt: 'x', tier: 'easy', agent: a }); assert.equal(r.isError, true); assert.match(r.content[0].text, /SENSITIVE mode: agent "\w+" is not delegated/); }
      for (const a of ['fixer', 'worker']) {
        let r = await st(s, { prompt: 'x', tier: 'easy', agent: a }); assert.match(r.content[0].text, /strictly mechanical boilerplate/);
        r = await st(s, { prompt: 'x', tier: 'easy', agent: a, mechanical: false }); assert.equal(r.isError, true);
        r = await st(s, { prompt: 'x', tier: 'easy', agent: a, mechanical: true }); assert.ok(!r.isError, a); assert.match(r.content[0].text, /mode=sensitive \(env OPENCODE_MODE\)/);
      }
      for (const a of ['explorer', 'librarian', 'deep-research', 'oracle']) { const r = await st(s, { prompt: 'x', tier: 'medium', agent: a }); assert.ok(!r.isError, a); }
      await waitFor(() => runs(f).length === 6);
    } finally { s.close(); }
  });
  test('sensitive default agent is explorer; blueprint default is worker; OPENCODE_BRIDGE_AGENT overrides only outside sensitive', async () => {
    let { f, s } = fresh({ OPENCODE_MODE: 'sensitive', OPENCODE_BRIDGE_AGENT: 'fixer' }); try { await s.text('opencode_start', { prompt: 'p', tier: 'easy' }); await waitFor(() => runs(f).length); const r = runs(f)[0].argv; assert.equal(r[r.indexOf('--agent') + 1], 'explorer'); } finally { s.close(); }
    ({ f, s } = fresh()); try { await s.text('opencode_start', { prompt: 'p', tier: 'easy' }); await waitFor(() => runs(f).length); const r = runs(f)[0].argv; assert.equal(r[r.indexOf('--agent') + 1], 'worker'); } finally { s.close(); }
    ({ f, s } = fresh({ OPENCODE_BRIDGE_AGENT: 'oracle' })); try { await s.text('opencode_start', { prompt: 'p', tier: 'easy' }); await waitFor(() => runs(f).length); const r = runs(f)[0].argv; assert.equal(r[r.indexOf('--agent') + 1], 'oracle'); } finally { s.close(); }
  });
  test('project .claude/sensitive in the cwd applies to start; insensitive allows designer and adds the parallel hint', async () => {
    touch(join(proj, '.claude', 'sensitive'));
    let { f, s } = fresh(); try { const r = await st(s, { prompt: 'x', tier: 'easy', agent: 'designer', cwd: deep }); assert.match(r.content[0].text, /SENSITIVE mode/); } finally { s.close(); }
    (await import('node:fs')).rmSync(join(proj, '.claude'), { recursive: true }); touch(join(proj, '.claude', 'insensitive'));
    ({ f, s } = fresh()); try { const r = await st(s, { prompt: 'ui', tier: 'easy', agent: 'designer', cwd: deep }); assert.ok(!r.isError); assert.match(r.content[0].text, /mode=insensitive \(.*insensitive\)/); assert.match(r.content[0].text, /Insensitive mode: prefer parallel lanes/); await waitFor(() => runs(f).length); } finally { s.close(); }
    (await import('node:fs')).rmSync(join(proj, '.claude'), { recursive: true });
  });
  test('explicit mode argument in start: sensitive restricts, insensitive does not lift a sensitive env', async () => {
    let { s } = fresh(); try { const r = await st(s, { prompt: 'x', tier: 'easy', agent: 'designer', mode: 'sensitive' }); assert.match(r.content[0].text, /SENSITIVE mode/); const bad = await st(s, { prompt: 'x', tier: 'easy', mode: 'nope' }); assert.match(bad.content[0].text, /mode must be one of/); } finally { s.close(); }
    ({ s } = fresh({ OPENCODE_MODE: 'sensitive' })); try { const r = await st(s, { prompt: 'x', tier: 'easy', agent: 'designer', mode: 'insensitive' }); assert.match(r.content[0].text, /SENSITIVE mode/); } finally { s.close(); }
  });
  test('blueprint hint for editors; none for read-only agents', async () => {
    const { s } = fresh(); try {
      assert.match(await s.text('opencode_start', { prompt: 'p', tier: 'easy', agent: 'fixer' }), /Blueprint mode: make sure the prompt is a written Blueprint/);
      assert.ok(!/Blueprint mode:/.test(await s.text('opencode_start', { prompt: 'p', tier: 'easy', agent: 'explorer' })));
    } finally { s.close(); }
  });
  test('prompt given to the agent: read-only agents get the READ-ONLY line, editors the build/test line; general / deep-research get the sub-lane guard', async () => {
    const { f, s } = fresh(); try {
      for (const a of ['explorer', 'oracle', 'fixer', 'general', 'deep-research']) await s.text('opencode_start', { prompt: 'THE TASK', tier: 'easy', agent: a });
      await waitFor(() => runs(f).length === 5);
      const msg = (a) => { const r = runs(f).find((x) => x.argv[x.argv.indexOf('--agent') + 1] === a).argv; return r.at(-1); };
      for (const a of ['explorer', 'oracle']) { assert.match(msg(a), /READ-ONLY: do not create, modify or delete any file/); assert.match(msg(a), /^Rules: do the work yourself, never delegate/); }
      assert.match(msg('fixer'), /Run the build\/test command given in the task and fix errors until it passes/); assert.ok(!/READ-ONLY/.test(msg('fixer')));
      for (const a of ['general', 'deep-research']) { assert.match(msg(a), /^Rules: you may use your own explorer\/librarian sub-lanes/); assert.ok(!/never delegate to other agents/.test(msg(a))); }
      for (const a of ['explorer', 'fixer', 'general']) { assert.ok(msg(a).endsWith('THE TASK')); assert.match(msg(a), /never run git commit\/push\/config/); }
    } finally { s.close(); }
  });
  test('secrets in the prompt are refused before anything starts', async () => {
    const { f, s } = fresh(); try {
      const secrets = ['key sk-abcdefghijklmnopqrstuvwxyz0123', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github_pat_abcdefghijklmnopqrstuvwxyz01234567', 'AKIAABCDEFGHIJKLMNOP', 'xoxb-1234567890-abcdef', '-----BEGIN RSA PRIVATE KEY-----', 'bot 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ012345678', 'password = "hunter2hunter2hunter2"', 'API_KEY=abcdef0123456789abcdef'];
      for (const sec of secrets) { const r = await st(s, { prompt: `use this: ${sec}`, tier: 'easy', agent: 'explorer' }); assert.equal(r.isError, true, sec); assert.match(r.content[0].text, /looks like it contains a secret/); assert.ok(!r.content[0].text.includes(sec)); }
      await new Promise((r) => setTimeout(r, 300)); assert.equal(runs(f).length, 0);
    } finally { s.close(); }
  });
  test('ordinary text that merely mentions tokens or keys is not blocked', async () => {
    const { f, s } = fresh(); try {
      for (const p of ['count the tokens in README', 'rename api_key to apiKey in the config loader', 'the password field is optional', 'read $SERVICE_TOKEN from the environment', 'sk-short']) { const r = await st(s, { prompt: p, tier: 'easy', agent: 'explorer' }); assert.ok(!r.isError, p); }
      await waitFor(() => runs(f).length === 5);
    } finally { s.close(); }
  });
  test('status and list show agent / tier / mode; list shows the title', async () => {
    const { s } = fresh(); try {
      const id = (await s.text('opencode_start', { prompt: 'p', tier: 'medium', agent: 'oracle', lane: 'x' })).match(/task (\w+)/)[1];
      await waitFor(async () => /^done/.test(await s.text('opencode_status', { id })));
      assert.match(await s.text('opencode_status', { id }), /oracle\/medium\/blueprint$/); assert.match(await s.text('opencode_list'), new RegExp(`${id} done \\d+s ses_fake01 oracle/medium/blueprint X/oracle: p`));
    } finally { s.close(); }
  });
  test('continuing a session keeps enforcement (tier still required)', async () => {
    const { s } = fresh(); try {
      const id = (await s.text('opencode_start', { prompt: 'p', tier: 'easy' })).match(/task (\w+)/)[1]; await waitFor(async () => /^done/.test(await s.text('opencode_status', { id })));
      const r = await st(s, { prompt: 'more', session: id }); assert.equal(r.isError, true); assert.match(r.content[0].text, /tier is required/);
    } finally { s.close(); }
  });
});
