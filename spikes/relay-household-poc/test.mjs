import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LoroDoc } from 'loro-crdt';

function run() {
  const base = new LoroDoc(); base.setPeerId(1);
  base.getMap('recipe:R1').set('title', 'Rice');
  base.getMap('recipe:R1:ingredient:I1').set('quantity', 1);
  const initial = base.export({mode:'snapshot'});
  const ben = new LoroDoc(), chi = new LoroDoc();
  ben.import(initial); chi.import(initial); ben.setPeerId(2); chi.setPeerId(3);
  const bv = ben.version(), cv = chi.version();
  ben.getMap('recipe:R1').set('title', 'Ben rice');
  ben.getMap('recipe:R1:ingredient:I1').set('quantity', 2);
  ben.getMap('purchases').set('ben-purchase-1', {item:'rice', units:1});
  chi.getMap('recipe:R1').set('title', 'Chi rice');
  chi.getMap('recipe:R1:ingredient:I1').set('unit', 'cup');
  chi.getMap('purchases').set('chi-purchase-1', {item:'rice', units:1});
  const b = ben.export({mode:'update', from:bv}), c = chi.export({mode:'update', from:cv});
  const a = new LoroDoc(), d = new LoroDoc(); a.import(initial); d.import(initial);
  for (const u of [c,b,b]) a.import(u);
  for (const u of [b,c,b]) d.import(u);
  const state = doc => ({recipe:doc.getMap('recipe:R1').toJSON(), ingredient:doc.getMap('recipe:R1:ingredient:I1').toJSON(), purchases:doc.getMap('purchases').toJSON()});
  assert.deepEqual(state(a), state(d));
  const dir = mkdtempSync('/home/x/agent-scratch/creative-cooking/relay-plan/loro-snapshot-');
  const path = join(dir, 'snapshot.bin');
  writeFileSync(path, a.export({mode:'snapshot'}));
  const reopened = new LoroDoc(); reopened.import(readFileSync(path));
  rmSync(dir, {recursive:true});
  assert.deepEqual(state(reopened), state(a));
  const s = state(a); assert.equal(Object.keys(s.purchases).length,2); assert.equal(s.ingredient.quantity,2); assert.equal(s.ingredient.unit,'cup');
  const intentions = ['Ben rice','Chi rice']; assert.ok(intentions.includes(s.recipe.title));
  const connectivity = {converged:true, snapshotReopened:true, intentions, winner:s.recipe.title, superseded:intentions.filter(x=>x!==s.recipe.title), independentFields:s.ingredient, deliveryCount:3, distinctPurchases:2, logicalAgreementTime:5};
  const shopping = {requested:1, physicalPurchases:2, policies:{editableQuantity:{duplicateUnits:1,unmetUnits:0,reconciliationActions:1, note:'Both physical purchases occur; one overwritten quantity can conceal one.'}, claimBeforeBuy:{duplicateUnits:1,unmetUnits:0,reconciliationActions:1,note:'Offline claims cannot prevent concurrent purchases without coordination.'}, events:{duplicateUnits:1,unmetUnits:0,reconciliationActions:1,note:'Two IDs remain visible; a compensating event records correction.'}}};
  const outageSets = [ ['relay'], ['relay','Ben'], ['relay','Ben','Chi-withholds'], ['Ana','Ben','Chi'] ];
  const recovery = outageSets.map(outages => {
    const available = ['Ana','Ben','Chi'].filter(x=>!outages.includes(x) && !outages.includes(x+'-withholds'));
    const guardians = available.length>=2;
    return {outages, printed:{success:true, assumption:'Dee has printed secret', cooperation:0, lockedMinutes:0}, guardians:{threshold:'2-of-3 people',available,success:guardians,cooperation:guardians?2:available.length,lockedMinutes:guardians?0:null}};
  });
  assert.equal(recovery[2].guardians.success,false); assert.equal(recovery[2].guardians.threshold,'2-of-3 people');
  const policies = [
    {policy:'unilateral', approvals:1, heads:['e2 excluding Ben','e2-prime excluding Ana'], detectionLag:1, memberMinutesLockedOut:{Ana:1,Ben:1,Chi:0,Dee:0}, choices:2, proposalsPerHonestAction:3},
    {policy:'canonical quorum', approvals:2, heads:['e2 excluding Ben','e2-prime excluding Ana'], detectionLag:1, memberMinutesLockedOut:{Ana:1,Ben:1,Chi:0,Dee:0}, choices:2, proposalsPerHonestAction:3, assumption:'different pairs approve conflicting successors; canonical selection is displayed, not silently applied'},
    {policy:'explicit fork / all reachable', approvals:'all reachable on each branch', heads:['e2 excluding Ben','e2-prime excluding Ana'], detectionLag:1, memberMinutesLockedOut:{Ana:1,Ben:1,Chi:0,Dee:0}, choices:2, proposalsPerHonestAction:3, assumption:'reachable sets differ across partitions'}
  ];
  for (const policy of policies) { assert.equal(policy.heads.length, 2); assert.equal(policy.choices, 2); }
  const devices = {AnaPhone:{accepted:['base','e2'],pending:[],quarantined:['e2-prime:Ben edit']}, AnaTablet:{accepted:['base'],pending:['offline local edit'],quarantined:[]}, BenPhone:{accepted:['base','e2-prime'],pending:['offline local edit'],quarantined:['e2:Ana edit']}, ChiPhone:{accepted:['base'],pending:[],quarantined:['e2:Ana edit','e2-prime:Ben edit']}, DeeReplacement:{accepted:['base'],pending:[],quarantined:[]}};
  const restored = JSON.parse(JSON.stringify(devices)); assert.deepEqual(restored,devices); assert.ok(restored.BenPhone.pending.length);
  const rejoin = {explicitCopyConsent:true, freshInvitationAcceptedByBoth:true, newEpoch:'e3', copied:[{content:'Ben recipe edit', provenance:'e2-prime:Ben'}], disputedLocalExportable:true, oldDataStillReadable:true, removedMemberNewEpochAccess:false, accessIsAssumption:true};
  assert.equal(rejoin.copied[0].provenance,'e2-prime:Ben'); assert.ok(rejoin.explicitCopyConsent && rejoin.freshInvitationAcceptedByBoth && rejoin.disputedLocalExportable);
  return {seed:'fixed-schedule-1',members:['Ana','Ben','Chi','Dee'],v1:connectivity,v2:shopping,v3:recovery,v4:{policies,devices,restartPreservesModel:true,rejoin,deviceReplacementChangesMembership:false,ordinaryEditApprovals:0, householdLockedMemberMinutes:2},limitations:['Protocol state and times are scripted illustrations, not network measurements.','Epoch access is an assumption; no encryption, signatures, secret sharing or security proof.','Restart for protocol state is JSON round-trip, not durable storage.']};
}
const first = JSON.stringify(run(),null,2)+'\n'; assert.equal(JSON.stringify(run(),null,2)+'\n',first); process.stdout.write(first);
