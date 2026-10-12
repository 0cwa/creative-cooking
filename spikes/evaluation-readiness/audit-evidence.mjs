// Evidence schema/integrity check; PASS does NOT mean production gates pass.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const e=JSON.parse(readFileSync(new URL('./evidence-inventory.json',import.meta.url),'utf8'));
const statuses=new Set(['PASS','PARTIAL','FAIL','NOT TESTED','PENDING']);
assert.equal(e.schemaVersion,1);
assert.match(e.baseline.sha,/^[a-f0-9]{40}$/);
assert.deepEqual(e.sources.map(x=>x.pr).sort((a,b)=>a-b),[37,38,39,40,41,42]);
for(const source of e.sources){
 assert.match(source.head,/^[a-f0-9]{40}$/);
 assert.ok(source.report.startsWith('docs/spikes/'));
 assert.ok(statuses.has(source.ci.result)&&statuses.has(source.experimental.result));
 for(const a of source.artifacts){assert.ok(a.id>0&&a.runId>0);}
 assert.ok(source.claims.length&&source.limits.length);
}
assert.deepEqual(e.combinations.map(x=>x.id).sort(),['AP','AS','LP','LS']);
for(const x of e.combinations){
 for(const k of ['independentComponents','actualEngineThroughSubstrate','mobile','e2eeAcl']) assert.ok(statuses.has(x[k]));
 assert.notEqual(x.e2eeAcl,'PASS','test-only AES/--auth open may not prove E2EE/ACL');
}
assert.equal(e.decisionReadiness.canSelectFinalProductionStack,false);
assert.ok(e.hardGates.length>=10&&e.hardGates.some(x=>x.status==='FAIL'));
for(const gate of e.hardGates)assert.ok(statuses.has(gate.status)&&gate.owner&&gate.missing);
assert.ok(e.risks.every(x=>x.risk&&x.mitigation&&x.owner&&x.confidence));
assert.ok(e.remainingExperiments.every((x,i)=>x.priority===i+1));
console.log('PASS: six pinned source reports and four stack comparisons are internally consistent. Production hard gates remain open.');
