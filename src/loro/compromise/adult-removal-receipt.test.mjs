import {test} from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import {domain} from '../authority/validator.mjs';
import {recipientBodyV2,recipientTargetV2} from './adult-removal-receipt.mjs';

await sodium.ready;
test('recipient commitments stay compact with multi-megabyte policy and proof evidence',async()=>{
 const provider={hash:async bytes=>sodium.crypto_generichash(32,bytes)},scope={kind:'household',id:'house'};
 const slot={operationId:'operation',identity:{version:1,scope,deviceId:'device',purpose:'data',epochId:'epoch'}};
 const entry={recipeId:null,sourceDocumentId:'old',sourceRevision:0,documentId:'new'};
 const seed={version:1,seedId:'seed',peerId:'1',identities:[],purchaseIds:[],snapshot:new Uint8Array([1])};
 const doc={seed,policyBundle:{policy:'x'.repeat(3*1024*1024)}};
 const key=new Uint8Array(32).fill(3),wrapped=new Uint8Array(48).fill(4);
 const target=await recipientTargetV2({provider,sodium,entry,slot,doc,key,wrapped});
 const changed=await recipientTargetV2({provider,sodium,entry,slot,doc:{...doc,policyBundle:{policy:doc.policyBundle.policy+'y'}},key,wrapped});
 assert.notEqual(target.policyBundleHash,changed.policyBundleHash);
 const proof=new Uint8Array(2*1024*1024).fill(5),record={scope,revision:0,acceptedParent:'head',authorizationSnapshot:'snapshot',authorityState:new Uint8Array(512*1024)};
 const body=await recipientBodyV2({provider,sodium,scope,pin:'pin',operationId:'op',recipientDeviceId:'device',eventHash:'event',grantHash:'grant',
  ciphertext:new Uint8Array(128),publisherProof:proof,publisherRecord:record,expected:record,next:record,selection:{from:'old',to:'new',deviceId:'device',index:0,signature:'0'.repeat(128)},targets:[target,target]});
 const compact=domain('adult-removal-recipient-receipt-v2',body);
 const legacy=domain('adult-removal-recipient-receipt-v1',{publisherProof:sodium.to_hex(proof),publisherRecord:{...record,authorityState:sodium.to_hex(record.authorityState)},targets:[{seed,policyBundle:doc.policyBundle},{seed,policyBundle:doc.policyBundle}]});
 assert(legacy.length>8*1024*1024);
 assert(compact.length<16*1024);
 assert.equal(body.targets[0].policyBundleHash,target.policyBundleHash);
});
