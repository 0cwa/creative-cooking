import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import sodium from 'libsodium-wrappers';
import {openSQLiteStorage} from '../storage/sqlite.ts';
import {domain} from './validator.mjs';
import {rootPin,policyId,initializeAuthority,acceptAdmissionAgreement,readAuthority,verifyAuthority} from './chain.mjs';
import {checkHouseholdCeremonies,existingRecipientContextBytes} from './ceremony.mjs';
import {ceremonyBytes} from '../pairing/candidate-v2.mjs';
import {durableSession,householdSessionContextBytes,verifyHouseholdSessionEvidence} from '../pairing/durable-session.mjs';
await sodium.ready;
const hex=b=>sodium.to_hex(b);
const encode=v=>v instanceof Uint8Array?{__bytes:hex(v)}:Array.isArray(v)?v.map(encode):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encode(x)])):v;
function sessionStore(){const rows=new Map();return {transaction(fn){const copy=structuredClone(rows),value=fn({get:k=>copy.get(k),put:(k,v)=>copy.set(k,structuredClone(v))});rows.clear();for(const [k,v] of copy)rows.set(k,v);return value}};}
async function fixture(){
 const db=new DatabaseSync(':memory:'),storage=openSQLiteStorage({executeSync:(sql,args=[])=>{const st=db.prepare(sql);return {rows:sql.startsWith('SELECT')?st.all(...args):(st.run(...args),[])}}});
 const keys=Object.fromEntries(['A','B','C','N'].map(id=>[id,{sign:sodium.crypto_sign_keypair(),box:sodium.crypto_box_keypair()}]));
 const provider={hash:async b=>sodium.crypto_generichash(32,b),verify:async(ref,b,s)=>{const key=keys[ref.replace('-key','')];return !!key&&sodium.crypto_sign_verify_detached(s,b,key.sign.publicKey)}};
 const sign=(id,purpose,v)=>hex(sodium.crypto_sign_detached(domain(purpose,v),keys[id].sign.privateKey)),hash=async(purpose,v)=>hex(await provider.hash(domain(purpose,v)));
 const scope={kind:'household',id:'home'},policy={kind:'allMinusOne',fixedCount:null};
 const root={householdId:'home',head:'',policyHash:await policyId(provider,policy),generation:1,epochId:'old-epoch',roster:['owner'],devices:['A','B','C'].map(deviceId=>({adultId:'owner',deviceId,signingKeyRef:deviceId+'-key',active:true})),policy,runtime:{documentId:'old-doc',authorPeers:{A:'1',B:'2',C:'3'},acceptedRecipients:['A','B','C']}};
 root.head=await rootPin(provider,root);await initializeAuthority(storage,root,root.head,provider);
 const agreement={version:1,householdId:'home',parentHead:root.head,policyHash:root.policyHash,roster:['owner'],delegation:'currentCooking',sourcePolicyHashes:[root.policyHash]},acceptance={adultId:'owner',deviceId:'B'};
 const delegationHash=await acceptAdmissionAgreement(storage,scope,root.head,provider,{...agreement,acceptances:[{...acceptance,signature:sign('B','admission-agreement-acceptance',{agreement,...acceptance})}]});
 const event={version:2,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',householdId:'home',parentHead:root.head,policyHash:root.policyHash,generation:1,epochId:'old-epoch',proposalId:'invite',kind:'inviteAdult',authorDeviceId:'B',frozenAdultRoster:['owner'],subject:{adultId:'new-owner',devices:[{deviceId:'N',signingKeyRef:hex(keys.N.sign.publicKey),wrappingKeyRef:hex(keys.N.box.publicKey),peerId:'4'}],documentId:'fresh-doc',newGeneration:2,newEpochId:'fresh-epoch'},nextPolicy:null};
 const eventHash=await hash('event',event),approval={version:1,householdId:'home',eventHash,parentHead:root.head,policyHash:root.policyHash,generation:1,epochId:'old-epoch',adultId:'owner',deviceId:'B'},item={event,authorSignature:sign('B','event-signature',event),approvals:[{...approval,signature:sign('B','approval-signature',approval)}]};
 const manifest={version:1,sourceDocument:'old-doc',sourceCheckpointHash:'11'.repeat(32),sourcePolicyHashes:[root.policyHash],projectedStateHash:'22'.repeat(32),newDocumentId:'fresh-doc',newGeneration:2,schemaVersion:'1'};
 const base={version:1,householdId:'home',parentHead:root.head,admissionEventHash:eventHash,sourcePolicyHashes:[root.policyHash],delegationHash,recipientAdult:'new-owner',recipientDevices:['N'],contentClasses:['recipe','shopping'],projectionManifestHash:await hash('projection-manifest',manifest),newDocumentGeneration:2,newEpochId:'fresh-epoch',keyEnvelopeRefs:['package']};
 const grant={...base,signatures:[{adultId:'owner',deviceId:'B',signature:sign('B','current-state-grant-signature',{grant:base,adultId:'owner',deviceId:'B'})}]},state=(await readAuthority(storage,scope,root.head,provider)).state,record=(await storage.readPairingAuthority(scope)).value;
 function evidence(sponsor,recipient,id,purpose='data'){
  const newcomer=recipient==='N',context=newcomer?{version:1,householdId:'home',parentHead:root.head,admissionEventHash:eventHash,sponsorAdult:'owner',recipientAdult:'new-owner',sponsorDeviceId:sponsor,sponsorSigningKeyRef:sponsor+'-key',sponsorWrappingKeyRef:hex(keys[sponsor].box.publicKey),recipientDeviceId:recipient,recipientSigningKeyRef:hex(keys[recipient].sign.publicKey),recipientWrappingKeyRef:hex(keys[recipient].box.publicKey)}:{version:1,householdId:'home',parentHead:root.head,admissionEventHash:eventHash,newEpochId:'fresh-epoch',sponsorDeviceId:sponsor,recipientDeviceId:recipient,recipientWrappingKey:hex(keys[recipient].box.publicKey)};
  const role=(role,deviceId)=>({role,deviceId,signingPublicKey:keys[deviceId].sign.publicKey,wrappingPublicKey:keys[deviceId].box.publicKey,nonce:sodium.randombytes_buf(32)});
  const transcript={version:1,sessionId:id,action:newcomer?'inviteAdult':'pairOwnDevice',scope,purpose,acceptedParent:root.head,authorizationSnapshot:record.authorizationSnapshot,initiator:role('initiator',sponsor),responder:role('responder',recipient),signaling:[newcomer?householdSessionContextBytes(context):existingRecipientContextBytes(context)]},guard={version:1,guardId:id+'-guard',scope,direction:'initiator-to-responder',purpose};
  const oob={hash:hex(sodium.crypto_generichash(32,ceremonyBytes(transcript,guard))),pins:Object.fromEntries(['initiator','responder'].map(r=>[r,{deviceId:transcript[r].deviceId,signingKey:hex(transcript[r].signingPublicKey),wrappingKey:hex(transcript[r].wrappingPublicKey)}]))};
  const open=(role,id)=>durableSession(sodium,sessionStore(),{signingSecret:keys[id].sign.privateKey,wrappingSecret:keys[id].box.privateKey},transcript,guard,role,oob),a=open('initiator',sponsor),b=open('responder',recipient),ao=a.initialize(),bo=b.initialize(),ar=a.respond(bo,0),br=b.respond(ao,0),aa=a.acknowledge(br,1),ba=b.acknowledge(ar,1);a.finish(ba,2);b.finish(aa,2);
  return {transcript,guard,oob,messages:a.evidence().messages,context};
 }
 return {db,storage,scope,root,provider,item,grant,manifest,state,record,evidence};
}
test('authority replay cannot exempt a device that sponsored none of its ceremonies',async()=>{
 const f=await fixture();try{
  const rows=()=>JSON.stringify(f.db.prepare('SELECT key,value FROM loro_records ORDER BY key').all()),before=rows(),newcomer=f.evidence('B','N','new');
  const admission={grant:f.grant,manifest:f.manifest,ceremonies:encode([newcomer]),existingCeremonies:encode([f.evidence('C','B','C-B'),f.evidence('B','C','B-C')]),localDeviceId:'A',operationId:'publication'};
  const state=structuredClone(f.state);state.events.push({...f.item,admission});
  await assert.rejects(verifyAuthority(state,f.root.head,f.provider),/INVALID_ADMISSION/);assert.equal(rows(),before);
  admission.localDeviceId='B';admission.existingCeremonies=encode([f.evidence('B','A','B-A'),f.evidence('B','C','B-C-correct')]);
  assert.ok((await verifyAuthority(state,f.root.head,f.provider)).nodes.has(f.grant.admissionEventHash));assert.equal(rows(),before);
 }finally{f.db.close();}
});
test('a complete archive-purpose ceremony cannot authorize household data admission',async()=>{
 const f=await fixture();try{
  const e=f.evidence('B','N','archive','archive'),before=await f.storage.readPairingAuthority(f.scope);
  await assert.rejects(checkHouseholdCeremonies(sodium,f.root,f.record.authorizationSnapshot,f.grant,[e],f.provider),/CONTEXT_MISMATCH|INVALID_PROOF/);
  assert.throws(()=>verifyHouseholdSessionEvidence(sodium,e.transcript,e.guard,e.oob,e.messages,e.context),/INVALID_PROOF/);
  assert.deepEqual(await f.storage.readPairingAuthority(f.scope),before);
 }finally{f.db.close();}
});
