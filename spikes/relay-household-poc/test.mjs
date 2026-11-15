import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LoroDoc } from 'loro-crdt';
import { recovery, trust } from './model.mjs';

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
  const connectivity = {converged:true, snapshotReopened:true, intentions, winner:s.recipe.title, superseded:intentions.filter(x=>x!==s.recipe.title), independentFields:s.ingredient, deliveryCount:3, distinctPurchases:2};
  const shopping = {requested:1, physicalPurchases:2, policies:{editableQuantity:{duplicateUnits:1,unmetUnits:0,reconciliationActions:1, note:'Both physical purchases occur; one overwritten quantity can conceal one.'}, claimBeforeBuy:{duplicateUnits:1,unmetUnits:0,reconciliationActions:1,note:'Offline claims cannot prevent concurrent purchases without coordination.'}, events:{duplicateUnits:1,unmetUnits:0,reconciliationActions:1,note:'Two IDs remain visible; a compensating event records correction.'}}};
  const copies = [{holder:'Ana',domain:'home'}, {holder:'Ana',domain:'phone'}, {holder:'Ben',domain:'home'}, {holder:'Chi',domain:'elsewhere'}];
  const cases = [
    {name:'code present',codePresent:true,confirmed:true},
    {name:'code missing',codePresent:false,confirmed:true},
    {name:'one unavailable',unavailable:['Ben'],confirmed:true},
    {name:'two unavailable',unavailable:['Ben','Chi'],confirmed:true},
    {name:'correlated home loss',lostDomains:['home'],unavailable:['Ana'],confirmed:true},
    {name:'withholding',unavailable:['Ben'],withholding:['Chi'],confirmed:true},
    {name:'confirmation pending',codePresent:true,confirmed:false}
  ].map(c=>({name:c.name,...recovery({copies,threshold:2,...c})}));
  assert.equal(cases[0].codeConfirmed,true); assert.equal(cases[1].codeCanUnwrap,false);
  assert.equal(cases[2].sharesConfirmed,true); assert.equal(cases[3].sharesCanUnwrap,false);
  assert.deepEqual(cases[3].eligible,['Ana']); assert.deepEqual(cases[4].eligible,['Chi']);
  assert.equal(cases[5].sharesCanUnwrap,false); assert.equal(cases[5].threshold,2); assert.equal(cases[6].codeConfirmed,false);
  const parent = {id:'base',members:['Ana','Ben','Chi','Dee']};
  const proposals = [
    {type:'proposal',id:'e2',parentState:parent,actor:'Ana',remove:'Ben'},
    {type:'proposal',id:'spam',parentState:parent,actor:'Ana',remove:'Ben'},
    {type:'proposal',id:'e2b',parentState:parent,actor:'Ben',remove:'Ana'}
  ];
  const delivery = [
    {type:'edit',device:'BenPhone',id:'local',epoch:'e2b',content:'offline rice'},
    {type:'receiveEdit',device:'AnaPhone',id:'ben-edit',epoch:'e2b',content:'Ben recipe'},
    {type:'deliver',device:'AnaPhone',id:'e2b'}, {type:'deliver',device:'AnaPhone',id:'e2'},
    {type:'deliver',device:'BenPhone',id:'e2'}, {type:'deliver',device:'BenPhone',id:'e2b'}
  ];
  const unilateral = trust([...proposals,...delivery],1);
  assert.equal(unilateral.repeated,1); assert.deepEqual(unilateral.devices.AnaPhone.heads,['e2','e2b']);
  assert.deepEqual(unilateral.devices.BenPhone.heads,['e2','e2b']); assert.equal(unilateral.devices.AnaPhone.quarantine.length,1);
  const reordered = trust([...proposals,...delivery.slice(0,2),...delivery.slice(2).reverse()],1);
  assert.deepEqual(reordered.devices.AnaPhone.heads,unilateral.devices.AnaPhone.heads);
  const quorum = trust([...proposals,{type:'approval',id:'e2',actor:'Chi'},{type:'approval',id:'e2b',actor:'Dee'},...delivery],2);
  assert.deepEqual(quorum.proposals.map(p=>p.approvals),[['Ana','Chi'],['Ben','Dee']]);
  assert.deepEqual(quorum.devices.AnaPhone.heads,['e2','e2b']);
  const denied = trust([...proposals,...delivery,{type:'copyRejoin',device:'AnaPhone',id:'ben-edit',actor:'Ana',parent:'e2',joiner:'Ben',newEpoch:'e3',copyConsent:false,invitationAccepted:true}],1);
  assert.equal(denied.devices.AnaPhone.copies.length,0);
  const rejoined = trust([...proposals,...delivery,{type:'copyRejoin',device:'AnaPhone',id:'ben-edit',actor:'Ana',parent:'e2',joiner:'Ben',newEpoch:'e3',copyConsent:true,invitationAccepted:true}],1);
  assert.equal(rejoined.devices.AnaPhone.copies[0].provenance,'ben-edit'); assert.ok(rejoined.devices.AnaPhone.inbox.length);
  const stateDir = mkdtempSync('/home/x/agent-scratch/creative-cooking/relay-plan/protocol-state-');
  const statePath = join(stateDir,'state.json'); writeFileSync(statePath,JSON.stringify(rejoined.devices));
  const loaded = JSON.parse(readFileSync(statePath,'utf8')); rmSync(stateDir,{recursive:true});
  assert.deepEqual(loaded,rejoined.devices); assert.equal(loaded.BenPhone.outbox[0].id,'local');
  return {seed:'fixed-schedule-1',v1:connectivity,v2:shopping,v3:cases,v4:{unilateral,quorum,rejoined,reorderedHeads:reordered.devices.AnaPhone.heads,diskReloadPreservesInboxOutbox:true},limitations:['Signatures, key possession and confirmation are assumed; no cryptography or security proof.','Disk reload checks serialized state, not atomic commits or crash consistency.','No relay order establishes authority; policy decisions remain open.']};
}
const first = JSON.stringify(run(),null,2)+'\n'; assert.equal(JSON.stringify(run(),null,2)+'\n',first); process.stdout.write(first);
