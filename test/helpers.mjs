// Test helpers: an MCP stdio client for server.mjs, run against the fake `opencode` in test/bin.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const SERVER = join(HERE, '..', 'server.mjs');
export const FAKE_BIN = join(HERE, 'bin');

export function tmp(prefix = 'ocb-') { return mkdtempSync(join(tmpdir(), prefix)); }

/** Start the bridge. `fake` = put the fake opencode first on PATH. Returns {rpc, call, text, notify, raw, close, stderr}. */
export function startServer({ fake = true, env = {}, root } = {}) {
  const workdir = tmp();
  const rootDir = root ?? workdir;
  mkdirSync(join(workdir, 'home'), { recursive: true });
  // hermetic: a private HOME (no ~/.claude/insensitive), no mode variables inherited from the caller
  const e = { ...process.env, HOME: join(workdir, 'home'), OPENCODE_BRIDGE_ROOT: rootDir, ...env };
  delete e.OPENCODE_MODE; delete e.OPENCODE_BRIDGE_MODE; delete e.CLAUDE_CONFIG_DIR; for (const [k, v] of Object.entries(env)) e[k] = v;
  if (fake) e.PATH = `${FAKE_BIN}:${process.env.PATH}`;
  const child = spawn(process.execPath, [SERVER], { env: e, stdio: ['pipe', 'pipe', 'pipe'], cwd: workdir });
  const pending = new Map(); const extra = []; let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  createInterface({ input: child.stdout }).on('line', (l) => {
    let m; try { m = JSON.parse(l); } catch { extra.push(l); return; }
    const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } else extra.push(m);
  });
  let id = 0;
  const rpc = (method, params = {}, timeout = 60000) => new Promise((resolve, reject) => {
    const i = ++id; const t = setTimeout(() => { pending.delete(i); reject(new Error(`timeout ${method}`)); }, timeout);
    pending.set(i, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
  const call = (name, args = {}) => rpc('tools/call', { name, arguments: args }).then((m) => m.result ?? m);
  const text = async (name, args = {}) => { const r = await call(name, args); return r.content?.[0]?.text ?? ''; };
  return { rpc, call, text, raw: (s) => child.stdin.write(s), notify: (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    extra, get stderr() { return stderr; }, workdir, rootDir, child,
    close() { child.stdin.end(); child.kill(); rmSync(workdir, { recursive: true, force: true }); } };
}

export const readLog = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, ms = 8000, step = 100) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('waitFor timed out'); await sleep(step); } }

/** Compile the sleeper stub into a directory as a binary called `opencode`; returns its path or null without a C compiler. */
export function buildStub(dir) {
  try { mkdirSync(dir, { recursive: true }); const bin = join(dir, 'opencode'); execFileSync('cc', ['-O0', '-o', bin, join(HERE, 'stub', 'sleeper.c')]); return bin; } catch { return null; }
}
export { writeFileSync, join };
