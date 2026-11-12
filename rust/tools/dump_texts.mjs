// Exports the texts / schemas / patterns of the Node server into rust/data/texts.json so that the Rust binary says exactly the
// same things (it embeds the file with include_str!). Run after changing any text in server.mjs:  node rust/tools/dump_texts.mjs
// The model and the timeout default are written as sentinels that the Rust binary replaces at run time.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.OPENCODE_BRIDGE_MODEL = '@@MODEL@@';
process.env.OPENCODE_BRIDGE_TIMEOUT_MIN = '1234';
const here = dirname(fileURLToPath(import.meta.url));
const { __shared: m } = await import(join(here, '..', '..', 'server.mjs'));
const out = {
  tools: m.tools, instructions: m.INSTRUCTIONS, modeRules: m.MODE_RULES, tierRule: m.TIER_RULE, verifyRule: m.VERIFY_RULE, roster: m.ROSTER,
  kinds: m.KINDS.map(([kind, transient, re, advice]) => [kind, transient, re.source, re.flags, advice]),
  secrets: m.SECRET_RES.map((re) => [re.source, re.flags]),
  guard: m.GUARD, guardLanes: m.GUARD_LANES, agentRuleReadOnly: m.AGENT_RULE('explorer'), agentRuleEdit: m.AGENT_RULE('fixer'),
  readOnly: [...m.READ_ONLY], editors: [...m.EDITORS], staleMin: m.STALE_MIN,
};
const target = process.argv[2] || join(here, '..', 'data', 'texts.json');
writeFileSync(target, JSON.stringify(out, null, 1));
console.log('wrote', target, JSON.stringify(out).length, 'bytes');
