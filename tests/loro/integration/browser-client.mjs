// Isolated acceptance harness: deterministic public test keys; not product pairing.
import {LoroDoc,decodeImportBlobMeta} from 'loro-crdt/base64';
import sodium from 'libsodium-wrappers';
import {FixtureOfflineRuntime} from '../../../src/loro/engine/runtime.mjs';
import {candidateCodec,SUITE} from '../../../src/loro/crypto/candidate.mjs';
import {testProvider} from '../../../src/loro/crypto/test-provider.mjs';
import {openIndexedDBStorage} from '../../../src/loro/storage/indexeddb.ts';
import {objectFrames,Reassembler,sendFrames,inboxAdapter,exportFile,importFile} from '../../../src/loro/transport/adapter.mjs';
await sodium.ready;
const who=new URL(location.href).searchParams.get('device');if(!['a','b'].includes(who))throw Error('device required');
const other=who==='a'?'b':'a', enc=new TextEncoder();
const identities={a:sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(1)),b:sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(2))};
const wrap=sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(3));
const p=testProvider(sodium,{signing:identities[who],publicSigning:identities[who].publicKey,publicRecipient:wrap.publicKey,initialKey:new Uint8Array(32).fill(4)});
p.sign=async (device,bytes)=>{if(device!==who)throw Error('UNAUTHORIZED');return sodium.crypto_sign_detached(bytes,identities[who].privateKey);};
p.verify=async (device,bytes,sig)=>!!identities[device]&&sodium.crypto_sign_verify_detached(sig,bytes,identities[device].publicKey);
const codec=candidateCodec(p), scope={scopeId:'house',documentId:'cooking',documentGeneration:0,branchHead:'head',authorizationSnapshot:'accepted-v1',policyHashes:['policy'],epochId:'epoch',authorDevice:who,acceptedAuthors:['a','b'],authorPeers:{a:'1',b:'2'},acceptedRecipients:['a','b'],suiteId:SUITE};
let db,runtime,adapter,pc,channel,fault='', cursor=null,sequence=0,received=[],receipts=[],errors=[], prepared=new Map();
const reassembler=new Reassembler('offline-session');
const signed=c=>enc.encode(JSON.stringify(['integration-receipt-v1',c]));
const receiptProvider={sign:async c=>sodium.crypto_sign_detached(signed(c),identities[who].privateKey),verify:async(c,b)=>!!identities[c.recipientId]&&sodium.crypto_sign_verify_detached(b,signed(c),identities[c.recipientId].publicKey)};
async function open(){
 db=await openIndexedDBStorage('loro-rtc-integration',b=>{if(fault===b)throw Error('injected');});
 const state=enc.encode(JSON.stringify({acceptedAuthors:scope.acceptedAuthors,authorPeers:scope.authorPeers,acceptedRecipients:scope.acceptedRecipients,epochId:scope.epochId,policyHashes:scope.policyHashes,documentId:scope.documentId,documentGeneration:scope.documentGeneration}));
 const old=await db.storage.readPairingAuthority({kind:'household',id:'house'});if(!old.ok)throw Error(old.error);
 if(!old.value){const result=await db.storage.compareAndSwapPairingAuthority({expectedRevision:null,record:{scope:{kind:'household',id:'house'},revision:0,acceptedParent:'head',authorizationSnapshot:'accepted-v1',authorityState:state}});if(!result.ok)throw Error(result.error);}
 runtime=new FixtureOfflineRuntime({storage:db.storage,codec,LoroDoc,decodeImportBlobMeta,scope,keyRef:'data'});
 adapter=inboxAdapter({storage:db.storage,reader:db.storage,verifyObject:async bytes=>{const x=await codec.openContent(bytes);if(x.header.scopeId!=='house'||x.header.authorDevice!==other)throw Error('INVALID_AUTHORITY');return x.object;},receiptProvider,scopeId:'house',source:other,recipientId:who,trustHead:'head'});
 const cursors=await db.storage.listCursors('house');if(!cursors.ok)throw Error(cursors.error);cursor=cursors.value.find(x=>x.source===other)?.cursor??null;
}
await open();
const wait=(target,event,condition)=>condition()?Promise.resolve():new Promise((resolve,reject)=>{let timer=setTimeout(()=>reject(Error('timeout '+event)),20000);target.addEventListener(event,()=>{if(condition()){clearTimeout(timer);resolve();}});});
function attach(c){channel=c;channel.binaryType='arraybuffer';channel.onmessage=async e=>{try{if(typeof e.data==='string'){const r=JSON.parse(e.data);receipts.push({...r,bytes:Uint8Array.from(r.bytes)});return;}const r=await reassembler.accept(new Uint8Array(e.data));if(r)received.push(r);}catch(e){errors.push(String(e));}};}
async function final(description,ip){await pc.setLocalDescription(description);await wait(pc,'icegatheringstatechange',()=>pc.iceGatheringState==='complete');const value=JSON.stringify(pc.localDescription).replace(/[a-f0-9-]+\.local/g,ip);return {device:who,value,signature:Array.from(sodium.crypto_sign_detached(enc.encode(value),identities[who].privateKey))};}
function verify(signal){if(signal.device!==other||!sodium.crypto_sign_verify_detached(Uint8Array.from(signal.signature),enc.encode(signal.value),identities[other].publicKey))throw Error('INVALID_SIGNAL');}
function transmitReceipt(receipt){channel.send(JSON.stringify({claims:receipt.claims,bytes:Array.from(receipt.bytes)}));}
window.integration={
 async offer(ip){pc=new RTCPeerConnection({iceServers:[]});attach(pc.createDataChannel('objects'));return final(await pc.createOffer(),ip);},
 async answer(signal,ip){verify(signal);pc=new RTCPeerConnection({iceServers:[]});pc.ondatachannel=e=>attach(e.channel);await pc.setRemoteDescription(JSON.parse(signal.value));return final(await pc.createAnswer(),ip);},
 async finish(signal){verify(signal);await pc.setRemoteDescription(JSON.parse(signal.value));},
 async connected(){if(!channel)await wait(pc,'datachannel',()=>!!channel);await wait(channel,'open',()=>channel.readyState==='open');return {max:pc.sctp.maxMessageSize};},
 close(){pc?.close();channel=null;},
 environment(){return {userAgent:navigator.userAgent,origin:location.origin};},
 fault(v){fault=v;},execute:(operationId,command,n)=>runtime.execute({operationId,command,deviceSequence:n}),read:async()=>{const {doc}=await runtime.document();return doc.toJSON();},
 objects:async()=>{let v=await runtime.outboundFor(other);return v.map(o=>({objectId:o.objectId,effect:JSON.parse(new TextDecoder().decode(o.bytes)).header.semanticEffectIds[0]}));},
 async send(id,transferId){const obj=(await runtime.outboundFor(other)).find(x=>x.objectId===id);if(!obj)throw Error('NOT_AUTHORIZED');const frames=await objectFrames({sessionId:'offline-session',streamId:who,transferId,bytes:obj.bytes});await sendFrames(channel,frames,pc.sctp.maxMessageSize);return frames.length;},
 async prepare(id,transferId){const obj=(await runtime.outboundFor(other)).find(x=>x.objectId===id);if(!obj)throw Error('NOT_AUTHORIZED');const frames=await objectFrames({sessionId:'offline-session',streamId:who,transferId,bytes:obj.bytes});prepared.set(transferId,frames);return frames.length;},
 async parts(transferId,indices){const frames=prepared.get(transferId);await sendFrames(channel,indices.map(i=>frames[i]),pc.sctp.maxMessageSize);},
 pending(){return {incomplete:reassembler.pending.size,completed:reassembler.completed.size,received:received.length,errors:[...errors]};},
 async premature(id,transferId){try{await adapter.applied(id,transferId);return false;}catch(e){return e.message==='NOT_APPLIED';}},
 async incoming(){for(let i=0;i<100&&received.length===0;i++)await new Promise(r=>setTimeout(r,50));if(!received.length)throw Error('NO_OBJECT '+errors.join(','));const object=received.shift(),next=String(++sequence);const receipt=await adapter.stage({transferId:object.transferId,bytes:object.bytes,expectedCursor:cursor,cursor:next});cursor=next;transmitReceipt(receipt);return receipt.claims;},
 async apply(objectId,transferId){const items=await db.storage.listStagedInbox('house');if(!items.ok)throw Error(items.error);const item=items.value.find(x=>x.itemId===objectId);if(!item)throw Error('NOT_STAGED');const result=await runtime.importItem(item);const receipt=await adapter.applied(objectId,transferId);transmitReceipt(receipt);return result;},
 async receipt(){for(let i=0;i<100&&receipts.length===0;i++)await new Promise(r=>setTimeout(r,50));if(!receipts.length)throw Error('NO_RECEIPT');const r=receipts.shift();await adapter.acceptReceipt({...r,receiptId:`${r.claims.transferId}:${r.claims.state}`,expectedRecipient:other});return r.claims;},
 async states(){const r=await db.storage.listReceiptStates('house');if(!r.ok)throw Error(r.error);return r.value;},
 async reopen(){db.close();await open();},
 async cleanup(){pc?.close();db.close();await new Promise((resolve,reject)=>{const q=indexedDB.deleteDatabase('loro-rtc-integration');q.onsuccess=resolve;q.onerror=()=>reject(q.error);q.onblocked=()=>reject(Error('DELETE_BLOCKED'));});},
 async denial(){try{await runtime.outboundFor('unaccepted');return false;}catch(e){return e.message==='INVALID_AUTHORITY';}},
 async signedTranscript(value){return {device:who,transcript:value,signature:Array.from(sodium.crypto_sign_detached(enc.encode(value),identities[who].privateKey)),publicKey:Array.from(identities[who].publicKey)};},
 async fileRoundtrip(id){const o=(await runtime.outboundFor(other)).find(x=>x.objectId===id);const data=exportFile({id:o.objectId,bytes:o.bytes});const parsed=importFile(data);const x=await codec.openContent(parsed.bytes);return parsed.id===x.object.id;},
};

// The local test server queues named operations; only this isolated test page enables it.
async function controlLoop(){for(;;){const response=await fetch(`/control?device=${who}`);const command=await response.json();if(command.stop)return;if(!command.id){await new Promise(r=>setTimeout(r,40));continue;}let result,error;try{result=await window.integration[command.method](...command.args);}catch(e){error=e.message;}await fetch('/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({device:who,id:command.id,result,error})});}}
if(new URL(location.href).searchParams.has('control')) controlLoop().catch(e=>console.error(e));
