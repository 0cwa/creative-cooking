import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUpdate, assertUpdate, ReceiptLedger, projectForSpace, MAX_UPDATE_BYTES } from './boundary.mjs';
const context = {engine:'loro',spaceId:'space:personal:fixture',documentId:'doc:recipe-1'};
const message = (bytes, dependencies=[]) => makeUpdate({...context,dependencies,bytes:Uint8Array.from(bytes)});
test('concurrent children wait for base, and duplicate deliveries do not multiply edits',()=>{
  const base=message([1]), left=message([2],[base.id]), right=message([3],[base.id]);
  const ledger=new ReceiptLedger(context);
  assert.equal(ledger.accept(right).ready.length,0);
  assert.equal(ledger.accept(left).ready.length,0);
  const ready=ledger.accept(base).ready;
  assert.deepEqual(new Set(ready.map(x=>x.id)),new Set([base.id,left.id,right.id]));
  assert.equal(ledger.accept(left).fresh,false);
  assert.equal(ledger.checkpoint().appliedIds.length,3);
});
test('wrong engine/namespace, corruption and identity spoofing all reject',()=>{
  const valid=message([1,2,3]);
  for(const wrong of [{engine:'automerge'},{spaceId:'space:household:fixture'},{documentId:'doc:other'}]){
    assert.throws(()=>assertUpdate(valid,{...context,...wrong}));
  }
  assert.throws(()=>assertUpdate({...valid,bytes:Uint8Array.from([1,2,4])},context));
  assert.throws(()=>assertUpdate({...valid,id:'f'.repeat(64)},context));
  assert.throws(()=>makeUpdate({...context,bytes:new Uint8Array(MAX_UPDATE_BYTES+1)}));
  assert.throws(()=>makeUpdate({...context,bytes:Uint8Array.from([1]),dependencies:['not-a-hash']}));
  assert.throws(()=>makeUpdate({...context,bytes:Uint8Array.from([1]),dependencies:['a'.repeat(64),'a'.repeat(64)]}));
});
test('explicit namespace projection excludes synthetic secrets and personal chat from households',()=>{
  const sentinel='SYNTHETIC_PROVIDER_API_KEY_NEVER_REPLICATE_XYZZY';
  const state={pantry:[{id:'p-1',name:'chickpeas',preference:5,token:sentinel}],
    recipes:[{id:'r-1',title:'Toast',portions:2,devicePrivate:sentinel}],
    chatMessages:[{id:'m-1',role:'user',content:'cooking idea',createdAt:'2026-01-01'}],
    settings:{allergies:['sesame'],model:'model',providerId:'openai',secret:sentinel},
    providerCredentials:{openai:sentinel},devicePrivateKey:sentinel};
  const personal=projectForSpace(state,'personal'),household=projectForSpace(state,'household');
  for(const projection of [personal,household]) assert.equal(JSON.stringify(projection).includes(sentinel),false);
  assert.equal(household.chatMessages,undefined);
  assert.equal(personal.chatMessages[0].content,'cooking idea');
  assert.throws(()=>projectForSpace(state,'untrusted'));
});
