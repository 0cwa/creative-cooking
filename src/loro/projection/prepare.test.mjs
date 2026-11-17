import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LoroDoc} from 'loro-crdt';
import sodium from 'libsodium-wrappers';
import {prepareCurrentCooking,classifyPendingEdit} from './prepare.mjs';
await sodium.ready;
test('new document contains only selected current fields and newly generated recipient key',async()=>{
 const original=new LoroDoc(); original.getMap('recipe').set('title','DELETED_CANARY'); original.commit(); original.getMap('recipe').set('title','soup'); original.getMap('private').set('chat','PERSONAL_CANARY'); original.commit();
 const oldKey=sodium.randombytes_buf(32), recipient=sodium.crypto_box_keypair(); let fresh;
 const provider={generateKey:async()=>{fresh=sodium.randombytes_buf(32);return {keyRef:'fresh'}},wrapKey:async(ref,who,context)=>{assert.equal(ref,'fresh');assert.equal(who,'recipient');const payload=new TextEncoder().encode(JSON.stringify({key:Array.from(fresh),context}));return sodium.crypto_box_seal(payload,recipient.publicKey)}};
 const context={householdId:'house',parentHead:'parent',oldDocumentId:'old',oldGeneration:1,oldEpochId:'old-epoch',newDocumentId:'new',newGeneration:2,newEpochId:'new-epoch'};
 const projected=await prepareCurrentCooking({LoroDoc,provider,source:{recipeTitle:original.getMap('recipe').get('title'),purchases:[{effectId:'buy',value:'rice'}]},context,recipients:['recipient']});
 const decoded=new LoroDoc(); decoded.import(projected.snapshot);
 assert.deepEqual(decoded.getMap('recipe').toJSON(),{title:'soup'}); assert.deepEqual(decoded.getMap('purchases').toJSON(),{buy:'rice'}); assert.deepEqual(decoded.getMap('private').toJSON(),{});
 const history=JSON.stringify(decoded.exportJsonUpdates(undefined,undefined,false)); assert.equal(history.includes('DELETED_CANARY'),false); assert.equal(history.includes('PERSONAL_CANARY'),false);
 const unwrapped=JSON.parse(new TextDecoder().decode(sodium.crypto_box_seal_open(projected.packages[0].bytes,recipient.publicKey,recipient.privateKey))); assert.deepEqual(Uint8Array.from(unwrapped.key),fresh); assert.notDeepEqual(Uint8Array.from(unwrapped.key),oldKey); assert.deepEqual(unwrapped.context,context);
 assert.equal(classifyPendingEdit({documentId:'old',generation:1,epochId:'old-epoch'},{documentId:'new',generation:2,epochId:'new-epoch'}),'PRESERVE_FOR_SEMANTIC_REBASE_OR_REVIEW');
});
