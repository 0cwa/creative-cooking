// Same-emulator test identities and signaling only; no remote-peer claim.
import {RTCPeerConnection,RTCSessionDescription} from 'react-native-webrtc';
import {open} from '@op-engineering/op-sqlite';
import * as framing from './compat-root/transport/adapter.mjs';
import {openSQLiteStorage} from './compat-root/storage/sqlite.ts';
import {nativeDurableTransfer} from './compat-root/native/direct-transport.mjs';
import {sha256} from './compat-root/native/sha256.native';
import sodium from './compat-root/native/sodium';
const enc=new TextEncoder();
const gather=p=>new Promise((resolve,reject)=>{if(p.iceGatheringState==='complete')return resolve();const timer=setTimeout(()=>reject(Error('ICE gathering timeout')),20000);p.onicegatheringstatechange=()=>{if(p.iceGatheringState==='complete'){clearTimeout(timer);resolve()}}});
export async function framedDirectProof(w){
 if(await sha256(new Uint8Array())!=='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')throw Error('SHA256 vector');
 const a=new RTCPeerConnection({iceServers:[]}),b=new RTCPeerConnection({iceServers:[]});const filename=`framed-${sodium.to_hex(sodium.randombytes_buf(8))}.sqlite`;let db=open({name:filename}),left,right,timer;
 try{
  const auth=await w.household.authorization(),objects=(await w.household.storage.listOutboundObjects(w.household.scope.scopeId)).value,opened=await w.household.codec.openContent(objects[0].bytes,auth.signingKeyRefs),header=opened.header,ref=auth.signingKeyRefs[header.authorDevice];
  const encrypted=await w.household.codec.sealContent(header,new Uint8Array(25000).fill(97),header.epochId,ref);if(encrypted.bytes.length<=framing.MAX_FRAME)throw Error('fixture too small');
  const storage=openSQLiteStorage(db),signing=w.disclosureProvider,receiptBytes=claims=>enc.encode(JSON.stringify(['native-proof-receipt',claims])),receiptProvider={sign:async claims=>signing.sign(ref,receiptBytes(claims)),verify:async(claims,sig)=>signing.verify(ref,receiptBytes(claims),sig)};
  const inbox=framing.inboxAdapter({storage,reader:storage,verifyObject:async bytes=>(await w.household.codec.openContent(bytes,auth.signingKeyRefs)).object,receiptProvider,scopeId:'framed-proof',source:'native-peer',recipientId:'fixture',trustHead:'test-head'});
  let resolveReceipt,rejectReceipt;const got=new Promise((resolve,reject)=>{resolveReceipt=resolve;rejectReceipt=reject});timer=setTimeout(()=>rejectReceipt(Error('direct timeout')),25000);
  const config={sessionId:'fixture-session',streamId:'fixture-stream',verifySession:async()=>({sessionId:'fixture-session'}),framing,sha256,inbox,cursorFor:async()=>({expectedCursor:null,cursor:'cursor-1'}),onReceipt:async receipt=>resolveReceipt(receipt),onError:rejectReceipt};
  let rightReady;const rightPromise=new Promise((resolve,reject)=>{rightReady={resolve,reject}});b.ondatachannel=e=>{nativeDurableTransfer(e.channel,config).then(x=>{right=x;rightReady.resolve(x)},rightReady.reject)};
  const channel=a.createDataChannel('framed-ciphertext'),ready=new Promise((resolve,reject)=>{channel.onopen=resolve;channel.onerror=reject});
  await a.setLocalDescription(await a.createOffer());await gather(a);await b.setRemoteDescription(new RTCSessionDescription(a.localDescription));await b.setLocalDescription(await b.createAnswer());await gather(b);await a.setRemoteDescription(new RTCSessionDescription(b.localDescription));await ready;left=await nativeDurableTransfer(channel,config);await rightPromise;await left.send('transfer-1',encrypted.bytes);
  const stored=await got;if(stored.claims.state!=='stored'||!await receiptProvider.verify(stored.claims,stored.bytes))throw Error('stored receipt');let premature=false;try{await right.applied(encrypted.id,'transfer-1')}catch{premature=true}if(!premature)throw Error('premature applied');
  const commit={version:2,expectedAuthority:{version:2,scope:{kind:'personal',id:'framed-proof'},record:null},scopeId:'framed-proof',operationId:'import',itemId:encrypted.id,documents:[{documentId:'doc',bytes:Uint8Array.of(1),expectedRevision:null}],commands:[{version:1,commandId:'command',effectId:'effect',documentId:'doc',kind:'write',payload:Uint8Array.of(1),dependencyEffectIds:[]}],effectIds:['effect']};
  if(!(await storage.commitImport(commit)).ok)throw Error('import commit');const applied=await right.applied(encrypted.id,'transfer-1');if(applied.claims.state!=='applied'||!await receiptProvider.verify(applied.claims,applied.bytes))throw Error('applied receipt');db.close();db=open({name:filename});const reopened=openSQLiteStorage(db);if(!(await reopened.getInboxApplication('framed-proof',encrypted.id)).value)throw Error('durable inbox');return 'PASS multi-frame encrypted native transfer, staged and applied signed receipts, durable reopen';
 }finally{clearTimeout(timer);left?.close();right?.close();a.close();b.close();db.close()}
}
