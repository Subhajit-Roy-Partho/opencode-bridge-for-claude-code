// The Rust binary embeds rust/data/texts.json, exported from server.mjs. This test fails when someone changes a text, a tool
// schema, an error pattern or a secret pattern in server.mjs and forgets to regenerate the file:  node rust/tools/dump_texts.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, tmp } from './helpers.mjs';

test('rust/data/texts.json is in sync with server.mjs', () => {
  const out = join(tmp(), 'texts.json');
  execFileSync(process.execPath, [join(HERE, '..', 'rust', 'tools', 'dump_texts.mjs'), out], { stdio: 'pipe' });
  assert.equal(readFileSync(out, 'utf8'), readFileSync(join(HERE, '..', 'rust', 'data', 'texts.json'), 'utf8'),
    'texts differ: run `node rust/tools/dump_texts.mjs` and commit rust/data/texts.json');
});
