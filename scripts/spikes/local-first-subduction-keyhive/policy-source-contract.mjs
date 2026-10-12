/**
 * Pin-aware SOURCE-INSPECTION ONLY security contract.
 * Fails closed and loudly on known unsafe policies. It is not an API/runtime
 * security test and MUST NOT be counted as an independent exploit execution.
 * Keep the JSON log even when security tests fail.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [sub, ark, output] = process.argv.slice(2);
if (!sub || !ark || !output) {
  console.error('Usage: node policy-source-contract.mjs <subduction-root> <ark-root> <result.json>');
  process.exit(2);
}
const expected = {
  subduction: 'f0af1aab5f2fd44e5b224c22fc8b62660d50bc01',
  ark: '5d09e8c8cfdebd5656b1426b66aea6b1395f83da'
};
for (const [name, folder] of Object.entries({ subduction: sub, ark })) {
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: folder, encoding: 'utf8' }).trim();
  assert.equal(actual, expected[name], 'stop: sources changed, inspect the new code');
}
const read = (root, path) => readFileSync(root + '/' + path, 'utf8');
const cli = read(sub, 'subduction_cli/src/policy.rs');
const put = read(sub, 'subduction_keyhive/src/policy.rs');
const subManifest = read(sub, 'Cargo.toml');
const arkManifest = JSON.parse(read(ark, 'package.json'));
const arkPolicy = read(ark, 'src/keyhive/automerge-repo-keyhive.ts');
const arkUtil = read(ark, 'src/utilities.ts');
const subCli = read(sub, 'subduction_cli/src/server.rs');
const f = (name, original, detail, path) => ({
  gate: name, expected: 'DENY', observed: 'UNSAFE_SOURCE_PATH', finding: detail, path,
  sha256: createHash('sha256').update(original).digest('hex'), evidenceKind: 'SOURCE-INSPECTED (not runtime)'
});
const findings = [];
if (/fn is_legacy[\s\S]*?id\.as_bytes\(\)\[16\.\.\].*all/.test(cli)
  && /if is_legacy\(&sedimentree_id\)\s*\{\s*return async \{ Ok\(\(\)\) \}\.boxed\(\);/m.test(cli)) {
  findings.push(f('legacy-unprotected-ID admission', cli,
    'CLI returns allow for legacy 16-byte document IDs in both fetch and put before checking Keyhive',
    'subduction_cli/src/policy.rs'));
}
if (/pub async fn authorize_put_with[\s\S]*?_requestor:\s*PeerId[\s\S]*?let identifier = Identifier::from\(\*author\.verifying_key\(\)\)/m.test(put)
 && /TODO: Only .author. is currently checked/.test(put)) {
  findings.push(f('forwarded-write-requestor-Relay', put,
    'verified AUTHOR Edit is checked, but ungranted forwarding REQUESTOR Relay is not checked',
    'subduction_keyhive/src/policy.rs'));
}
if (/async authorizePut\(_requestor, author, sedimentreeId\)/.test(arkPolicy)) {
  findings.push(f('ARK-JS-forwarded-write-requestor', arkPolicy,
    'ARK JS server policy also ignores forwarding requestor', 'src/keyhive/automerge-repo-keyhive.ts'));
}
if (/if \(isUnprotectedDocId\(sidBytes\)\) return;/.test(arkPolicy)
 && /if \(isUnprotectedDocId\(sidBytes\)\)/.test(arkPolicy)) {
  findings.push(f('ARK-JS-legacy-unprotected-bypass', arkPolicy,
    'ARK JS server policy bypasses ACL checks on unprotected IDs', 'src/keyhive/automerge-repo-keyhive.ts'));
}
assert.match(subCli, /default_value_t = AuthMode::Keyhive/, 'server must default to keyhive');
assert.match(arkUtil, /isUnprotectedDocId/, 'ARK legacy predicate not found');
assert.match(subManifest, /keyhive_core = "0\.6\.0"/, 'Subduction pinned core version changed');
assert.equal(arkManifest.dependencies['@automerge/automerge-subduction'], '0.16.1');
assert.equal(arkManifest.dependencies['@keyhive/keyhive'], '0.3.0-alpha.1');
assert.equal(arkManifest.dependencies['@automerge/automerge-repo'], '2.6.0-subduction.48');
assert.match(subManifest, /automerge_subduction_wasm = \{ version = "0\.19\.0"/);
const report = {
  version: 1, classification: 'SOURCE-INSPECTION-ONLY',
  commitPins: expected, sourceSnapshot: new Date().toISOString(),
  packageCoherence: {
    ark: Object.fromEntries(['@automerge/automerge-repo', '@automerge/automerge-subduction', '@keyhive/keyhive']
      .map(k => [k, arkManifest.dependencies[k]])),
    subductionRust: '0.19.0 with keyhive_core=0.6.0',
    compatibleEndToEnd: 'NOT ESTABLISHED: bridge 0.16.1 != 0.19.0'
  }, findings, outcome: findings.length > 0 ? 'FAIL_SOURCE_SECURITY_GATES' : 'SOURCE_GATES_PASS_PENDING_RUNTIME'
};
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log('CC_POLICY_SOURCE=' + JSON.stringify(report));
if (findings.length) {
  console.error('SECURITY FAIL (source gates): ' + findings.map(x => x.gate).join(', '));
  process.exitCode = 1; // red CI is intentional; security failures are not waived.
}
