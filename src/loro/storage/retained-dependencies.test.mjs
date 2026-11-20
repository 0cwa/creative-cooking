import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retainedRecipeDependencies,sameRetainedPolicyProvenance} from './core.ts';

test('retained dependency comparison binds exact receipt, recipe and effects',()=>{
 const row={targetDocumentId:'target',recipeId:'recipe',identities:[{effectId:'a'},{effectId:'b'}],sources:[{effectId:'a',policyHashes:['restricted'],incomplete:true},{effectId:'b',policyHashes:[],incomplete:true}]};
 const provenance={statement:new TextEncoder().encode(JSON.stringify(['creative-cooking/authority-candidate/v1','policy-provenance-receipt-v1',{rows:[row,{...row,targetDocumentId:'sibling',recipeId:'other',identities:[{effectId:'c'}],sources:[{effectId:'c',policyHashes:['sibling-policy'],incomplete:true}]}]}])),signature:'ab'.repeat(64)};
 assert.equal(sameRetainedPolicyProvenance(provenance,structuredClone(provenance)),true);
 assert.equal(sameRetainedPolicyProvenance(provenance,{...provenance,signature:'cd'.repeat(64)}),false);
 const altered=structuredClone(provenance);altered.statement[0]^=1;
 assert.equal(sameRetainedPolicyProvenance(provenance,altered),false);
 assert.deepEqual([...retainedRecipeDependencies(provenance,'target','recipe',['a','b'])], [['a',{policyHashes:['restricted'],incomplete:true}],['b',{policyHashes:[],incomplete:true}]]);
 assert.equal(retainedRecipeDependencies(provenance,'target','recipe',['c']),null);
 assert.equal(retainedRecipeDependencies(provenance,'sibling','recipe',['a']),null);
 assert.equal(retainedRecipeDependencies(provenance,'target','recipe',['missing']),null);
});
