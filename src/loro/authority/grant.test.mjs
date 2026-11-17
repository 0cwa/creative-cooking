import {test} from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import {domain} from './validator.mjs';
import {checkGrantSignatures} from './grant.mjs';
await sodium.ready;
const pairs=Object.fromEntries(['a1','a2','b1','c1','new'].map(x=>[x,sodium.crypto_sign_keypair()]));
const provider={hash:async b=>sodium.crypto_generichash(32,b),verify:async (k,b,s)=>!!pairs[k] && sodium.crypto_sign_verify_detached(s,b,pairs[k].publicKey)};
const parent={householdId:'house',head:'head',policyHash:'policy',generation:1,epochId:'old',roster:['a','b','c'],devices:['a1','a2','b1','c1'].map(deviceId=>({deviceId,adultId:deviceId[0],signingKeyRef:deviceId,active:true})),policy:{kind:'allMinusOne',fixedCount:null},runtime:{documentId:'doc',authorPeers:{a1:'1',a2:'2',b1:'3',c1:'4'},acceptedRecipients:['a1','a2','b1','c1']}};
const unsigned={version:1,householdId:'house',parentHead:'head',admissionEventHash:'event',sourcePolicyHashes:['policy'],delegationHash:'delegation',recipientAdult:'d',recipientDevices:['new'],contentClasses:['pantry','recipe','shopping'],projectionManifestHash:'manifest',newDocumentGeneration:2,newEpochId:'new',keyEnvelopeRefs:['envelope']};
const proof=(deviceId,grant=unsigned)=>{const adultId=deviceId[0];return {adultId,deviceId,signature:Buffer.from(sodium.crypto_sign_detached(domain('current-state-grant-signature',{grant,adultId,deviceId}),pairs[deviceId].privateKey)).toString('hex')}};
const check=(grant,p=parent)=>checkGrantSignatures(p,grant,provider);
test('real signatures prove distinct parent quorum but never authorize publication',async()=>{
 const result=await check({...unsigned,signatures:[proof('a1'),proof('b1')]}); assert.equal(result.reason,'ADMISSION_EVIDENCE_REQUIRED'); assert.match(result.grantHash,/^[0-9a-f]{64}$/);
 assert.equal((await check({...unsigned,signatures:[proof('a1'),proof('a2')]})).reason,'QUORUM_REQUIRED');
 assert.equal((await check({...unsigned,signatures:[proof('a1'),proof('a1')]})).reason,'INVALID_PROOF');
});
test('tampering, newcomer votes, stale context and sparse evidence fail closed',async()=>{
 const signatures=[proof('a1'),proof('b1')];
 for(const change of [{recipientAdult:'x'},{recipientDevices:['a1']},{keyEnvelopeRefs:['one','two']},{projectionManifestHash:'other'},{parentHead:'stale'},{newEpochId:'old'},{contentClasses:['private']},{recipientDevices:Array(1)}]) assert.notEqual((await check({...unsigned,...change,signatures})).reason,'ADMISSION_EVIDENCE_REQUIRED');
 assert.equal((await check({...unsigned,signatures:[proof('new')]})).reason,'INVALID_PROOF');
 assert.equal((await check({...unsigned,signatures:Array(1)})).reason,'INVALID_INPUT');
});
test('unanimous and fixed thresholds use the frozen parent',async()=>{
 const signatures=[proof('a1'),proof('b1')];
 assert.equal((await check({...unsigned,signatures},{...parent,policy:{kind:'unanimous',fixedCount:null}})).reason,'QUORUM_REQUIRED');
 assert.equal((await check({...unsigned,signatures:[proof('a1')]},{...parent,policy:{kind:'fixed',fixedCount:1}})).reason,'ADMISSION_EVIDENCE_REQUIRED');
});

test('agreement requires each frozen adult to accept the exact current-cooking delegation',async()=>{
 const {checkAdmissionAgreement}=await import('./grant.mjs');
 const agreement={version:1,householdId:'house',parentHead:'head',policyHash:'policy',roster:['a','b','c'],delegation:'currentCooking',sourcePolicyHashes:['policy']};
 const acceptance=deviceId=>{const adultId=deviceId[0];return {adultId,deviceId,signature:Buffer.from(sodium.crypto_sign_detached(domain('admission-agreement-acceptance',{agreement,adultId,deviceId}),pairs[deviceId].privateKey)).toString('hex')}};
 const acceptances=['a1','b1','c1'].map(acceptance);
 assert.equal((await checkAdmissionAgreement(parent,{...agreement,acceptances},provider)).status,'accepted');
 for(const bad of [{...agreement,delegation:'none',acceptances},{...agreement,sourcePolicyHashes:['other'],acceptances},{...agreement,acceptances:acceptances.slice(0,2)},{...agreement,acceptances:[acceptances[0],acceptances[0],acceptances[2]]}]) assert.equal((await checkAdmissionAgreement(parent,bad,provider)).status,'deny');
});

test('manifest binds exact fresh snapshot, source policy and signed grant',async()=>{
 const {checkGrantManifest}=await import('./grant.mjs');
 const snapshot=new Uint8Array([1,2,3]);
 const digest=async(p,v)=>Buffer.from(await provider.hash(domain(p,v))).toString('hex');
 const manifest={version:1,sourceDocument:'doc',sourceCheckpointHash:'checkpoint',sourcePolicyHashes:['policy'],projectedStateHash:await digest('projection-snapshot',Buffer.from(snapshot).toString('hex')),newDocumentId:'fresh',newGeneration:2,schemaVersion:'1'};
 const grant={...unsigned,projectionManifestHash:await digest('projection-manifest',manifest)};
 assert.equal((await checkGrantManifest(parent,grant,manifest,snapshot,provider)).reason,'SOURCE_AND_PROJECTION_EVIDENCE_REQUIRED');
 for(const [m,b] of [[{...manifest,newDocumentId:'doc'},snapshot],[{...manifest,sourceCheckpointHash:'other'},snapshot],[manifest,new Uint8Array([1,2,4])],[{...manifest,sourcePolicyHashes:['other']},snapshot]]) assert.equal((await checkGrantManifest(parent,grant,m,b,provider)).status,'deny');
});
