// Static checks for sync-architecture-explorer.html. Run: node docs/plans/visuals/check-sync-explorer.mjs
// Checks script syntax, that the embedded model functions are verbatim copies of the spike,
// that every literal element ID the script queries exists, and that each scenario's
// decision matches the spike's own decide(). It does not render or click anything.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const spike = join(here, '../../../spikes/relay-household-poc');
const html = readFileSync(join(here, 'sync-architecture-explorer.html'), 'utf8');
const { decide } = await import(join(spike, 'contracts.mjs'));

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
assert.equal(scripts.length, 1, 'one inline script');
const src = scripts[0];
new vm.Script(src, { filename: 'explorer-inline.js' });
assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|<iframe|src="http|href="http|@import|url\(http/.test(html), 'no network or external resources');
assert.ok(!/\bvh\b|height:\s*100%/.test(html.replace(/<script>[\s\S]*<\/script>/, '')), 'no viewport-height CSS');
assert.ok(html.length < 1_000_000, 'under 1 MB');

const fnText = (text, name) => {
  const start = text.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' present');
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end + 2);
};
const contractsSrc = readFileSync(join(spike, 'contracts.mjs'), 'utf8');
const modelSrc = readFileSync(join(spike, 'model.mjs'), 'utf8');
assert.equal(fnText(src, 'decide'), fnText(contractsSrc, 'decide'), 'decide() is verbatim');
assert.equal(fnText(src, 'reconstruction'), fnText(modelSrc, 'reconstruction'), 'reconstruction() is verbatim');

// Every literal $('id') query must exist as an element id in the markup.
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const queried = new Set([...src.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map(m => m[1]));
for (const t of ['arch', 'pc', 'rc', 'tk']) queried.add('sx-tab-' + t), queried.add('sx-panel-' + t), queried.add(t + '-readout');
for (const id of ['rc-g-ben', 'rc-g-chi', 'rc-g-dee', 'rc-dup', 'rc-consent', 'rc-confirm']) queried.add(id), queried.add(id + '-wrap');
const missing = [...queried].filter(id => !ids.has(id));
assert.deepEqual(missing, [], 'queried ids exist');
assert.ok(ids.has('sync-explorer'), 'root id');

// Run the pure model section without a DOM and compare with the spike.
const sandbox = { window: {}, console };
vm.runInNewContext(src, sandbox);
const M = sandbox.window.__syncExplorerModel;
assert.ok(M, 'model exported');
const rows = [];
const pc = (s, want) => {
  const full = Object.assign({ proof: true, conflict: false, consent: 'none', local: false, widen: false }, s);
  const { req, decision } = M.pcRequest(full);
  assert.deepEqual(decide(JSON.parse(JSON.stringify(req))), JSON.parse(JSON.stringify(decision)), 'same as spike');
  assert.equal(decision.result + '(' + decision.reasons[0] + ')', want, JSON.stringify(s));
  rows.push(['pc', JSON.stringify(s), want]);
};
pc({ scenario: 'ai-recipe' }, 'Allow(OK)');
pc({ scenario: 'ai-recipe', proof: false }, 'Pending(MISSING_EVIDENCE)');
pc({ scenario: 'ai-recipe', conflict: true }, 'Pending(POLICY_UNRESOLVED)');
pc({ scenario: 'ai-allergy' }, 'RequireConsent(CONSENT_REQUIRED)');
pc({ scenario: 'ai-allergy', consent: 'other' }, 'RequireConsent(CONSENT_REQUIRED)');
pc({ scenario: 'ai-allergy', consent: 'exact' }, 'Allow(OK)');
pc({ scenario: 'ben-note' }, 'Deny(PROHIBITED)');
pc({ scenario: 'ben-note', consent: 'exact' }, 'Deny(PROHIBITED)');
pc({ scenario: 'ben-note', local: true }, 'LocalOnly(LOCAL_ALTERNATIVE)');
pc({ scenario: 'relax' }, 'Deny(PROHIBITED)');
pc({ scenario: 'relax', local: true }, 'Deny(PROHIBITED)'); // local control is not offered here
pc({ scenario: 'relax', widen: true }, 'Allow(OK)');
pc({ scenario: 'replay', consent: 'other' }, 'RequireConsent(CONSENT_REQUIRED)');
pc({ scenario: 'replay', consent: 'exact' }, 'Allow(OK)');

const rc = (s, want) => {
  const full = Object.assign({}, M.RC_DEFAULTS[s.scenario], s);
  const lanes = M.rcLanes(full);
  for (const l of lanes) assert.deepEqual(decide(JSON.parse(JSON.stringify(l.req))), JSON.parse(JSON.stringify(l.decision)));
  const got = lanes.map(l => l.id + ':' + l.decision.result + '(' + l.decision.reasons[0] + ')').join(' ');
  assert.equal(got, want, JSON.stringify(s));
  rows.push(['rc', JSON.stringify(s), want]);
};
rc({ scenario: 'self' }, 'recovery:Allow(OK) editing:LocalOnly(LOCAL_EDIT) authority:Pending(ADMISSION_REQUIRED)');
rc({ scenario: 'self', confirm: true }, 'recovery:Allow(OK) editing:LocalOnly(LOCAL_EDIT) authority:Allow(OK)');
rc({ scenario: 'assisted' }, 'recovery:Allow(OK) editing:LocalOnly(LOCAL_EDIT) authority:Pending(ADMISSION_REQUIRED)');
rc({ scenario: 'assisted', gBen: false, dup: true }, 'recovery:Pending(QUORUM_REQUIRED) editing:LocalOnly(LOCAL_EDIT) authority:Pending(ADMISSION_REQUIRED)');
rc({ scenario: 'assisted', consent: false }, 'recovery:RequireConsent(CONSENT_REQUIRED) editing:LocalOnly(LOCAL_EDIT) authority:Pending(ADMISSION_REQUIRED)');
rc({ scenario: 'outside' }, 'recovery:Allow(OK) editing:LocalOnly(LOCAL_EDIT) authority:Deny(PROHIBITED)');
rc({ scenario: 'escrow' }, 'recovery:RequireConsent(CONSENT_REQUIRED) editing:LocalOnly(LOCAL_EDIT) authority:Pending(ADMISSION_REQUIRED)');
rc({ scenario: 'escrow', consent: true }, 'recovery:Allow(OK) editing:LocalOnly(LOCAL_EDIT) authority:Pending(ADMISSION_REQUIRED)');

const plain = x => JSON.parse(JSON.stringify(x));
const r1 = plain(M.rogue({ scenario: 'rogue1', choice: 'none' }).res), r2 = plain(M.rogue({ scenario: 'rogue2', choice: 'ben' }).res);
assert.equal(r1.deviceVote.approved, false); assert.equal(r1.adultVote.approved, false);
assert.equal(r2.deviceVote.approved, true); assert.equal(r2.adultVote.approved, false); assert.equal(r2.adultVote.electorate, 2);
assert.deepEqual(r2.quarantined.map(o => o.id), ['bad1', 'bad2']); assert.deepEqual(r2.rejectedHistoryExport.map(o => o.id), ['good', 'bad1', 'bad2']);
rows.push(['rogue', 'rogue1', 'device 1/3 fails, adult 1/2 fails'], ['rogue', 'rogue2+ben', 'device 2/3 passes, adult 1/2 fails, bad1+bad2 quarantined, all 3 exported']);

console.log('ok: syntax, verbatim decide()/reconstruction(), ' + queried.size + ' queried ids exist, ' + rows.length + ' scenario decisions match the spike');
for (const r of rows) console.log('  ' + r.join('  '));
