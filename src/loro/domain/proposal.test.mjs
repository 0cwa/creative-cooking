import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LoroDoc} from 'loro-crdt/nodejs';
import {apply,checkPreconditions,proposalMapName} from './registry.mjs';
const command=(kind,data,dependencyEffectIds=[])=>({version:1,kind,commandId:kind,effectId:kind,dependencyEffectIds,data});
test('proposal acceptance requires an existing pending proposal and its creation effect',()=>{
 const doc=new LoroDoc();
 const make=command('chef-proposal-create',{conversationId:'a:b',proposalId:'c',toolName:'pantry_add',arguments:'{"names":["carrot"]}',status:'pending',createdAt:'2026-01-01T00:00:00Z'});
 const effect=command('chef-effect',{mutations:[{collection:'pantry',id:'i',field:'name',value:'x'}]}); effect.effectId='household';
 const accept=command('chef-accept',{conversationId:'a:b',proposalId:'c',effectIds:['household'],status:'applied',proposal:{toolName:'pantry_add',arguments:'{"names":["carrot"]}',status:'pending',createdAt:'2026-01-01T00:00:00Z',effectId:'chef-proposal-create'},effect},['chef-proposal-create']);
 assert.throws(()=>checkPreconditions(doc,accept),/PROPOSAL_NOT_PENDING/);
 checkPreconditions(doc,make);apply(doc,make);
 assert.throws(()=>checkPreconditions(doc,{...accept,dependencyEffectIds:[]}),/MISSING_DEPENDENCY/);
 checkPreconditions(doc,accept);apply(doc,accept);
 assert.throws(()=>checkPreconditions(doc,accept),/PROPOSAL_NOT_PENDING/);
 assert.notEqual(proposalMapName('a:b','c'),proposalMapName('a','b:c'));
});
