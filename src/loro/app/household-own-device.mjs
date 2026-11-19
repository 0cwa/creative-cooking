import {
 authorityBytes,encodeEvidence,readAuthority,snapshotId,verifyAuthority
} from '../authority/chain.mjs';
import {admissionThreshold,domain} from '../authority/validator.mjs';
import {checkOwnDeviceCeremony,ownDeviceHash,ownDeviceSignal} from '../authority/own-device.mjs';
import {policyBaseline,verifyPolicyBaseline} from '../authority/policy-baseline.mjs';
import {durableSession} from '../pairing/durable-session.mjs';
import {makeKeyPackage,withOpenedKeyPackage} from '../pairing/key-package.mjs';
import {
 openDeviceCopy,pairingDigest,pairingText,parsePairingText,sealDeviceCopy,verifyDeviceCopyFile,MAX_PERSONAL_PAIRING_FILE
} from '../pairing/personal-copy.mjs';
import {
 HOUSEHOLD_OWN_DEVICE_FILE,exact,must,sameOwnDevice,inspectOwnDeviceSnapshot,ownDeviceCopyHash,ownDeviceSourcesHash,ownDevicePacketContext,
 ownDeviceReceiptBody,verifyOwnDeviceCopy,verifyOwnDeviceSuccessor
} from '../pairing/household-own-device.mjs';
import {verifyHouseholdParentRecord} from './household-parent.mjs';
import {householdReceiverIds} from './household-transfer.mjs';
import {captureOwnDeviceCopySet,installOwnDeviceSetFile,installEstablishedOwnDeviceSet,selectedOwnDeviceSet,isOwnDeviceSetFile,publishOwnDeviceSet,reopenOwnDeviceSet} from '../pairing/household-own-device-set.mjs';
import {existingRecipientContextBytes} from '../authority/ceremony.mjs';
import {ownDeviceRecipientSignal,verifyOwnDeviceRecipients} from '../pairing/household-own-device-recipients.mjs';
import {preflightOwnDeviceLocalTransition} from '../pairing/household-own-device-local-transition.mjs';
import {ceremonyBytes} from '../pairing/candidate-v2.mjs';
import {openSelectedRecipeCatalog} from './selected-recipe-catalog.mjs';

const roles=['initiator','responder'];
const other=role=>role==='initiator'?'responder':'initiator';
const hex64=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,100}$/.test(value);
export const MAX_HOUSEHOLD_OWN_DEVICE_MESSAGE=2_200_000;

export function householdOwnDevice({
 name,sodium:s,scope,pin,storage,provider,store,pins,identity,runtime,service,keys,master,withSecrets,LoroDoc,
 prepareJoinedSequences,finalizeJoinedSequences,randomUUID
}){
 const {deviceId,signingKey,wrappingKey}=identity,own={deviceId,signingKey,wrappingKey};
 const digest=bytes=>pairingDigest(s,bytes);
 const same=(a,b)=>sameOwnDevice(s,a,b);
 const fingerprint=participant=>digest(domain('household-own-device-fingerprint',participant));
 const requestBytes=request=>domain('household-own-device-request',request);
 const prefix='household-own-device/v1:';
 const slot=key=>prefix+(key==='initiator'?JSON.stringify([key,scope.id,pin]):key);
 const belongs=proposal=>proposal?.bundle?.rootPin===pin&&same(proposal.bundle.scope,scope);
 const savedIn=(tx,key)=>{
  const saved=tx.get(slot(key));
  if(saved!==undefined||key!=='initiator')return saved;
  const legacy=tx.get(prefix+'initiator');
  return belongs(legacy?.proposal)?legacy:undefined;
 };
 const read=key=>store.transaction(tx=>savedIn(tx,key),{readOnly:true});
 const write=(key,value,old)=>store.transaction(tx=>{
  if(!same(savedIn(tx,key),old)||(key==='responder'&&!same(tx.get(slot('request')),value.proposal.request)))throw Error('CONFLICT');
  tx.put(slot(key),value);
 });
 const participant=(role,keys,nonce)=>({role,deviceId:keys.deviceId,signingPublicKey:s.from_hex(keys.signingKey),
  wrappingPublicKey:s.from_hex(keys.wrappingKey),nonce:s.from_hex(nonce)});
 const text=value=>pairingText(s,value);
 const parse=value=>parsePairingText(s,value,MAX_HOUSEHOLD_OWN_DEVICE_MESSAGE);
 const rootRecord=async (bundle,rootPin,head)=>verifyHouseholdParentRecord({provider,bundle,
  confirmedRootPin:rootPin,confirmedSelectedHead:head,explicit:true});
 async function current(){
  const {expectedAuthority}=await runtime.authorization();
  const record=must(await storage.readPairingAuthority(scope)), selected=expectedAuthority?.record;
  if(!record||!same(record.scope,scope)||!same(expectedAuthority.scope,scope)||
     record.revision!==selected?.revision||record.authorizationSnapshot!==selected?.authorizationSnapshot||
     record.acceptedParent!==selected?.acceptedParent||record.authorizationSnapshot!==runtime.scope.authorizationSnapshot||
     record.acceptedParent!==runtime.scope.branchHead)throw Error('CONFLICT');
  const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record.authorityState));
  const verified=await verifyAuthority(state,pin,provider),parent=verified.nodes.get(record.acceptedParent);
  const device=parent?.devices.find(entry=>entry.active&&entry.deviceId===deviceId);
  if(state.activeHead!==record.acceptedParent||!device||!parent.runtime.acceptedRecipients.includes(deviceId))throw Error('INVALID_AUTHORITY');
  const resolved={expectedAuthority,scope:runtime.scope,adultId:device.adultId};
  return {resolved,record,state,parent};
 }
 async function request(renew=false){
  const old=await read('request');
  if(old&&!renew)return text(old);
  const request={...own,nonce:s.to_hex(s.randombytes_buf(32))};
  const item={request,signature:s.to_hex(await provider.sign(signingKey,requestBytes(request)))};
  await store.transaction(tx=>{
   if(!same(tx.get(slot('request')),old))throw Error('CONFLICT');
   tx.put(slot('request'),item);
   tx.put(slot('responder'),null);
  });
  return text(item);
 }
 async function readRequest(item){
  const r=item?.request;
  if(!exact(item,['request','signature'])||!exact(r,['deviceId','signingKey','wrappingKey','nonce'])||
     !id(r.deviceId)||![r.signingKey,r.wrappingKey,r.nonce].every(hex64)||
     typeof item.signature!=='string'||!/^[0-9a-f]{128}$/.test(item.signature)||
     !await provider.verify(r.signingKey,requestBytes(r),s.from_hex(item.signature)))throw Error('INVALID_REQUEST');
  return r;
 }
 async function inspectProposal(proposal,role){
  if(!exact(proposal,['version','bundle','adultId','peerId','parentRevision','request','transcript','guard'])||proposal.version!==1||
     (!Number.isSafeInteger(proposal.parentRevision)||proposal.parentRevision<0)||typeof proposal.peerId!=='string'||!/^[1-9][0-9]{0,19}$/.test(proposal.peerId)||BigInt(proposal.peerId)>18446744073709551615n)throw Error('INVALID_PROOF');
  const {bundle,transcript:t,guard:g,adultId,peerId,parentRevision}=proposal;
  if(role==='initiator'&&!belongs(proposal))throw Error('OOB_REQUIRED');
  const record=await rootRecord(bundle,bundle.rootPin,bundle.selectedHead);
  const verified=await verifyAuthority(bundle.state,bundle.rootPin,provider),parent=verified.nodes.get(bundle.selectedHead);
  const oob=checkOwnDeviceCeremony(s,bundle.rootPin,parent,t,g,adultId,peerId,parentRevision,verified.wrappingByHead.get(parent.head).get(t.initiator.deviceId));
  const r=await readRequest(proposal.request);
  if(!same(oob.pins[role],own)||!same(t.responder,participant('responder',r,r.nonce))||
     !same(record.scope,t.scope)||record.authorizationSnapshot!==t.authorizationSnapshot)throw Error('INVALID_PROOF');
  if(role==='responder'&&!same(await read('request'),proposal.request))throw Error('INVALID_REQUEST');
  return {proposal,parent,record,oob,view:{text:text(proposal),code:oob.hash,rootPin:bundle.rootPin,head:bundle.selectedHead,
   adultId,peerDevice:oob.pins[other(role)].deviceId}};
 }
 async function reusable(proposal,live){
  if(!belongs(proposal))return false;
  if(proposal.parentRevision===live.record.revision&&proposal.bundle.selectedHead===live.record.acceptedParent&&
     proposal.transcript.authorizationSnapshot===live.record.authorizationSnapshot)return true;
  const saved=must(await storage.readHouseholdOwnDeviceRelease(scope,proposal.transcript.sessionId,false));
  return !!saved?.file&&same(saved.next,live.record);
 }
 async function retainedSponsor(proposal){
  const saved=must(await storage.readHouseholdOwnDeviceSetRetained(scope,proposal.transcript.sessionId));
  if(!saved)return null;
  const result=await reopenOwnDeviceSet({storage,scope,pin,provider,sodium:s,LoroDoc,keys,
   operationId:proposal.transcript.sessionId,wrappingSecret:undefined});
  if(!result.file||result.item.event.authorDeviceId!==deviceId||saved.guardId!==proposal.guard.guardId||
    result.item.event.subject.transcriptHash!==ownDeviceHash(s,proposal.transcript,proposal.guard))
   throw Error('INVALID_AUTHORITY');
  return result;
 }
 async function retainedLegacySponsor(proposal){
  const saved=must(await storage.readHouseholdOwnDeviceRelease(scope,proposal.transcript.sessionId,false));
  if(!saved?.file)return false;
  const selected=await readAuthority(storage,scope,pin,provider);
  if(selected.activeHead!==saved.next.acceptedParent)return false;
  // Require the storage baseline and the signed successor to match the selected state.
  must(await storage.readHouseholdOwnDeviceRelease(scope,proposal.transcript.sessionId));
  const {record,oob}=await inspectProposal(proposal,'initiator');
  const checked=await verifyOwnDeviceSuccessor({sodium:s,provider,pin,parentRecord:record,next:saved.next,proposal:{hash:oob.hash,guard:proposal.guard}});
  verifyDeviceCopyFile(s,HOUSEHOLD_OWN_DEVICE_FILE,saved.file,oob.hash,proposal.transcript.initiator.signingPublicKey);
  if(checked.proof.guard.guardId!==saved.guardId||!same(checked.item,selected.state.events.at(-1))||
     !same(checked.selection,selected.state.selections.at(-1)))throw Error('INVALID_AUTHORITY');
  return true;
 }
 async function propose(incoming,confirmedFingerprint){
  const item=parse(incoming),r=await readRequest(item),old=await read('initiator');
  if(fingerprint({deviceId:r.deviceId,signingKey:r.signingKey,wrappingKey:r.wrappingKey})!==confirmedFingerprint)throw Error('OOB_REQUIRED');
  const live=await current(),{resolved,record,state,parent}=live;
  if(old&&same(old.proposal.request,item)&&await reusable(old.proposal,live))return (await inspectProposal(old.proposal,'initiator')).view;
  await runtime.authorize();
  const {doc}=await runtime.document();
  const occupied=new Set([...Object.values(parent.runtime.authorPeers),...doc.oplogVersion().toJSON().keys()]);
  let peerId;
  do peerId=String(BigInt('0x'+s.to_hex(s.randombytes_buf(8))));
  while(peerId==='0'||occupied.has(peerId));
  const transcript={version:1,sessionId:randomUUID(),action:'pairOwnDevice',scope,purpose:'data',
   acceptedParent:parent.head,authorizationSnapshot:record.authorizationSnapshot,
   initiator:participant('initiator',own,s.to_hex(s.randombytes_buf(32))),responder:participant('responder',r,r.nonce),
   signaling:[ownDeviceSignal(pin,parent,resolved.adultId,peerId,record.revision)]};
  const guard={version:1,guardId:randomUUID(),scope,direction:'initiator-to-responder',purpose:'data'};
  const proposal={version:1,bundle:{version:1,scope,rootPin:pin,selectedHead:parent.head,state},
   adultId:resolved.adultId,peerId,parentRevision:record.revision,request:item,transcript,guard};
  const {view}=await inspectProposal(proposal,'initiator');
  if(view.text.length>MAX_HOUSEHOLD_OWN_DEVICE_MESSAGE)throw Error('TOO_LARGE');
  await write('initiator',{proposal,confirmed:false},old);
  return view;
 }
 async function confirm(role,incoming,peerFingerprint,rootPin,head,code){
  if(!roles.includes(role))throw Error('INVALID_PROOF');
  const old=await read(role);
  const checked=await inspectProposal(role==='initiator'?old?.proposal:parse(incoming),role);
  const {proposal,record,oob}=checked;
  if(proposal.bundle.rootPin!==rootPin||record.acceptedParent!==head||oob.hash!==code||
     fingerprint(oob.pins[other(role)])!==peerFingerprint)throw Error('OOB_REQUIRED');
  if(role==='initiator'){
   const live=await current();
   if(live.record.authorizationSnapshot!==record.authorizationSnapshot||live.record.revision!==proposal.parentRevision)throw Error('STALE_AUTHORITY');
  }else{
   const local=must(await storage.readPairingAuthority(record.scope));
   if(local&&(local.revision!==0||!same(local,record)))throw Error('STALE_AUTHORITY');
   await pins.save({version:1,scope:record.scope,pin:rootPin,head});
  }
  if(!old?.confirmed||!same(old.proposal,proposal))await write(role,{proposal,confirmed:true},old);
  return progress(role);
 }
 async function withSession(role,use){
  const saved=await read(role);
  if(!saved?.confirmed)throw Error('OOB_REQUIRED');
  const checked=await inspectProposal(saved.proposal,role);
  const {transcript,guard}=saved.proposal;
  const localStore={transaction:(apply,options)=>store.transaction(tx=>{
   if(!same(savedIn(tx,role),saved)||(role==='responder'&&!same(tx.get(slot('request')),saved.proposal.request)))throw Error('CONFLICT');
   return apply(tx);
  },options)};
  return withSecrets(secrets=>use({...checked,secrets,session:durableSession(s,localStore,secrets,transcript,guard,role,checked.oob)}));
 }
 function progress(role){
  return withSession(role,async({session})=>{
   await session.initialize();
   const {offer,response,ack,complete}=await session.outgoing();
   return {complete,text:text({offer,response,ack}),stage:ack?'Acknowledgement':response?'Response':'Challenge'};
  });
 }
 async function accept(role,incoming){
  const message=parsePairingText(s,incoming);
  if(!exact(message,['offer','response','ack'])||!exact(message.offer,['role','hash','challenge','signature'])||
     !(message.response===null||exact(message.response,['role','hash','offer','token','signature']))||
     !(message.ack===null||exact(message.ack,['role','hash','response','signature']))||(message.ack&&!message.response))throw Error('INVALID_PROOF');
  await withSession(role,async({session})=>{
   await session.initialize();
   const {revision}=await session.outgoing();
   await session.respond(message.offer,revision);
   if(message.response)await session.acknowledge(message.response,revision+1);
   if(message.ack)await session.finish(message.ack,revision+2);
  });
  return progress(role);
 }
 async function resume(role){
  const saved=await read(role);
  if(!saved)return null;
  if(role==='initiator'&&(!belongs(saved.proposal)||
    !await retainedSponsor(saved.proposal)&&!await retainedLegacySponsor(saved.proposal)&&!await reusable(saved.proposal,await current())))return null;
  const {view}=await inspectProposal(saved.proposal,role);
  const sc=saved.proposal.bundle.scope;
  let installed=null;
  if(role==='responder'&&saved.confirmed){
   const {operationId}=householdReceiverIds(s,sc,deviceId),receipt=must(await storage.householdRecipient.find(sc.id,operationId));
   const paired=must(await storage.readHouseholdOwnDeviceSetReceipt(sc,saved.proposal.transcript.sessionId));
   if(receipt?.ownDevice&&receipt.guardId===saved.proposal.guard.guardId||paired?.recipient.deviceId===deviceId){
    const joined={name,storage,scope:sc,pin:saved.proposal.bundle.rootPin,provider,deviceId,operationId,
     confirmedParent:saved.proposal.bundle.selectedHead};
    const opened=await finalizeJoinedSequences(joined);
    try{installed={scope:sc,head:opened.resolved.scope.branchHead};}finally{opened.sequences.close();}
   }
  }
  return {...view,installed,progress:saved.confirmed?await progress(role):null};
 }
 async function prepareSet(code){
  return withSession('initiator',async({proposal,record,oob,session})=>{
   if(code!==oob.hash||!belongs(proposal))throw Error('OOB_REQUIRED');
   const {messages}=await session.evidence();
   const key='set-preparation:'+JSON.stringify([scope.id,pin,proposal.transcript.sessionId]);
   const saved=await read(key);
   let live;
   try{live=await current();}catch(error){if(saved)throw Error('SOURCE_CHANGED');throw error;}
   if(record.authorizationSnapshot!==live.record.authorizationSnapshot||record.acceptedParent!==live.record.acceptedParent||proposal.parentRevision!==live.record.revision||
      proposal.adultId!==live.resolved.adultId){
    throw Error(saved?'SOURCE_CHANGED':'STALE_AUTHORITY');
   }
   if(runtime.authority.installedSet?.paired)throw Error('UNSUPPORTED_VERSION');
   const expected=await runtime.authorize();
   if(!same(expected,live.resolved.expectedAuthority))throw Error(saved?'SOURCE_CHANGED':'STALE_AUTHORITY');
   let captured;
   try{captured=await captureOwnDeviceCopySet({runtime,service,sodium:s,peerId:proposal.peerId,seedId:proposal.transcript.sessionId});}
   catch(error){if(saved&&['CONFLICT','STALE_AUTHORITY'].includes(error.message))throw Error('SOURCE_CHANGED');throw error;}
   const publicResult=({item,selection,head})=>({version:1,code:oob.hash,
    parent:{head:live.record.acceptedParent,authorizationSnapshot:live.record.authorizationSnapshot,revision:live.record.revision},
    transition:{item,selection,head},requiredRecipientIds:live.parent.runtime.acceptedRecipients.filter(id=>id!==deviceId).sort()});
   if(saved){
    if(saved.copyHash!==captured.copyHash||!same(saved.proposal,proposal)||!same(saved.messages,messages))throw Error('SOURCE_CHANGED');
    const checked=await verifyOwnDeviceSuccessor({sodium:s,provider,pin,parentRecord:live.record,next:saved.next,proposal:{hash:oob.hash,guard:proposal.guard},eventVersion:5});
    if(checked.item.event.subject.copyHash!==captured.copyHash||!same(checked.proof.messages,messages))throw Error('SOURCE_CHANGED');
    try{must(await storage.checkSelectedHouseholdSources(captured.guard));}catch{throw Error('SOURCE_CHANGED');}
    return structuredClone(publicResult(checked));
   }
   const signed=await signCopy(live,proposal,oob,messages,5,{baseline:captured.set.documents[0].baseline,copyHash:captured.copyHash});
   const checked=await verifyOwnDeviceSuccessor({sodium:s,provider,pin,parentRecord:live.record,next:signed.next,proposal:{hash:oob.hash,guard:proposal.guard},eventVersion:5});
   const result=publicResult(checked);
   const retained={proposal,messages,copyHash:captured.copyHash,next:signed.next};
   must(await storage.checkSelectedHouseholdSources(captured.guard));
   await store.transaction(tx=>{
    if(!same(savedIn(tx,'initiator')?.proposal,proposal)||!savedIn(tx,'initiator')?.confirmed||tx.get(slot(key))!==undefined)throw Error('CONFLICT');
    tx.put(slot(key),retained);
   });
   return structuredClone(result);
  });
 }
 // Check the offered metadata against both the selected local authority and the
 // signed, completed newcomer transition before exposing session parameters.
 async function checkEstablishedOffer(offer,local,recipient) {
  if(!exact(offer,['version','publisherParent','publisherNext','context','transcript','guard'])||offer.version!==1)throw Error('INVALID_PROOF');
  const {publisherParent,publisherNext,context:c,transcript:t,guard:g}=offer;
  const checked=await verifyOwnDeviceSuccessor({sodium:s,provider,pin,parentRecord:publisherParent,next:publisherNext,eventVersion:5});
  const preflight=await preflightOwnDeviceLocalTransition({sodium:s,provider,pin,localParent:local.record,publisherParent,publisherNext,deviceId:recipient.deviceId});
  const parent=preflight.parent,event=checked.item.event,sponsor=parent.devices.find(d=>d.active&&d.deviceId===event.authorDeviceId),
   target=parent.devices.find(d=>d.active&&d.deviceId===recipient.deviceId&&d.adultId===recipient.adultId);
  const expected={version:1,householdId:scope.id,parentHead:parent.head,admissionEventHash:checked.head,newEpochId:event.epochId,
   sponsorDeviceId:event.authorDeviceId,recipientDeviceId:recipient.deviceId,recipientWrappingKey:recipient.wrappingKey};
  if(!sponsor||!target||!parent.runtime.acceptedRecipients.includes(sponsor.deviceId)||!parent.runtime.acceptedRecipients.includes(target.deviceId)||
     sponsor.deviceId===target.deviceId||event.subject.deviceId===target.deviceId||target.signingKeyRef!==recipient.signingKey||
     !hex64(recipient.wrappingKey)||!same(c,expected)||t?.action!=='pairOwnDevice'||t.purpose!=='data'||!same(t.scope,scope)||
     t.acceptedParent!==parent.head||t.authorizationSnapshot!==publisherParent.authorizationSnapshot||g?.direction!=='initiator-to-responder'||g.purpose!=='data'||
     t.initiator?.deviceId!==sponsor.deviceId||s.to_hex(t.initiator.signingPublicKey)!==sponsor.signingKeyRef||
     s.to_hex(t.initiator.wrappingPublicKey)!==s.to_hex(checked.proof.transcript.initiator.wrappingPublicKey)||
     t.responder?.deviceId!==recipient.deviceId||s.to_hex(t.responder.signingPublicKey)!==recipient.signingKey||
     s.to_hex(t.responder.wrappingPublicKey)!==recipient.wrappingKey||!Array.isArray(t.signaling)||t.signaling.length!==2||
     !same(t.signaling[0],existingRecipientContextBytes(expected))||!same(t.signaling[1],ownDeviceRecipientSignal(checked.head,event.subject.copyHash,event.epochId)))throw Error('INVALID_PROOF');
  const hash=digest(ceremonyBytes(t,g));
  const pins=Object.fromEntries(roles.map(role=>[role,{deviceId:t[role].deviceId,signingKey:s.to_hex(t[role].signingPublicKey),wrappingKey:s.to_hex(t[role].wrappingPublicKey)}]));
  return {context:structuredClone(c),transcript:structuredClone(t),guard:structuredClone(g),oob:{hash,pins}};
 }
 async function prepareEstablishedOffer(code,recipientIdentity){
  const recipient=structuredClone(recipientIdentity);
  if(!exact(recipient,['version','adultId','deviceId','signingKey','wrappingKey'])||recipient.version!==1||!id(recipient.adultId)||!id(recipient.deviceId)||!hex64(recipient.signingKey)||!hex64(recipient.wrappingKey))throw Error('INVALID_PROOF');
  const prepared=await prepareSet(code),live=await current(),savedInitiator=await read('initiator'),proposal=savedInitiator?.proposal;
  const retained=proposal&&await read('set-preparation:'+JSON.stringify([scope.id,pin,proposal.transcript.sessionId]));
  if(!retained||!prepared.requiredRecipientIds.includes(recipient.deviceId)||!same(prepared.parent,{head:live.record.acceptedParent,authorizationSnapshot:live.record.authorizationSnapshot,revision:live.record.revision}))throw Error('INVALID_AUTHORITY');
  const checked=await verifyOwnDeviceSuccessor({sodium:s,provider,pin,parentRecord:live.record,next:retained.next,proposal:{hash:code,guard:proposal.guard},eventVersion:5});
  if(!same(prepared.transition,{item:checked.item,selection:checked.selection,head:checked.head})||!same(checked.proof.messages,retained.messages))throw Error('SOURCE_CHANGED');
  const target=live.parent.devices.find(d=>d.active&&d.deviceId===recipient.deviceId&&d.adultId===recipient.adultId);
  if(!target||target.signingKeyRef!==recipient.signingKey||!hex64(recipient.wrappingKey))throw Error('INVALID_AUTHORITY');
  const context={version:1,householdId:scope.id,parentHead:live.record.acceptedParent,admissionEventHash:checked.head,newEpochId:checked.item.event.epochId,sponsorDeviceId:deviceId,recipientDeviceId:recipient.deviceId,recipientWrappingKey:recipient.wrappingKey};
  const binding=JSON.stringify([scope,pin,checked.head,live.record.authorizationSnapshot,recipient,wrappingKey]);
  const saved=await store.transaction(tx=>{
   const key=slot('established-offer:'+digest(new TextEncoder().encode(binding))),old=tx.get(key);if(old)return old;
   const transcript={version:1,sessionId:randomUUID(),action:'pairOwnDevice',scope,purpose:'data',acceptedParent:live.record.acceptedParent,authorizationSnapshot:live.record.authorizationSnapshot,
    initiator:participant('initiator',own,s.to_hex(s.randombytes_buf(32))),responder:participant('responder',recipient,s.to_hex(s.randombytes_buf(32))),
    signaling:[existingRecipientContextBytes(context),ownDeviceRecipientSignal(checked.head,checked.item.event.subject.copyHash,checked.item.event.epochId)]};
   const guard={version:1,guardId:randomUUID(),scope,direction:'initiator-to-responder',purpose:'data'};
   const offer={version:1,publisherParent:live.record,publisherNext:retained.next,context,transcript,guard};tx.put(key,offer);return offer;
  });
  if(!same(saved.publisherParent,live.record)||!same(saved.publisherNext,retained.next))throw Error('CORRUPT_DRAFT');
  const result=await checkEstablishedOffer(saved,live,recipient),encoded=text(saved);
  if(new TextEncoder().encode(encoded).length>MAX_HOUSEHOLD_OWN_DEVICE_MESSAGE)throw Error('TOO_LARGE');
  return {...result,text:encoded};
 }
 async function verifyEstablishedOffer(incoming,confirmedHash){
  if(!hex64(confirmedHash))throw Error('CONFIRMATION_REQUIRED');
  const offer=parse(incoming),live=await current();
  if(!same(await runtime.authorize(),live.resolved.expectedAuthority))throw Error('STALE_AUTHORITY');
  const result=await checkEstablishedOffer(offer,live,identity);
  if(result.oob.hash!==confirmedHash)throw Error('CONFIRMATION_REQUIRED');
  return result;
 }
 async function publishPreparedSet(code,establishedProofs){
  return withSession('initiator',async({proposal,record,parent,oob,secrets,session})=>{
   if(code!==oob.hash||!belongs(proposal))throw Error('OOB_REQUIRED');
   const {messages}=await session.evidence();
   const saved=await read('set-preparation:'+JSON.stringify([scope.id,pin,proposal.transcript.sessionId]));
   if(!saved||!same(saved.proposal,proposal)||!same(saved.messages,messages))throw Error('INVALID_PROOF');
   const replay=await retainedSponsor(proposal);
   if(replay){
    if(!same(replay.item,(await verifyOwnDeviceSuccessor({sodium:s,provider,pin,parentRecord:record,next:saved.next,proposal:{hash:oob.hash,guard:proposal.guard},eventVersion:5})).item))throw Error('INVALID_AUTHORITY');
    const recipients=await verifyOwnDeviceRecipients({sodium:s,provider,successor:replay,parent,authorizationSnapshot:record.authorizationSnapshot,evidence:establishedProofs});
    if(recipients.length!==replay.establishedRecipients.length||recipients.some(recipient=>!replay.establishedRecipients.some(entry=>entry.recipientDeviceId===recipient.deviceId&&entry.ceremonyGuardId===recipient.guardId&&entry.transcriptHash===recipient.transcriptHash)))throw Error('INVALID_PROOF');
    return {file:replay.file,establishedRecipients:replay.establishedRecipients,head:replay.head,replayed:true};
   }
   if(runtime.authority.installedSet?.paired)throw Error('UNSUPPORTED_VERSION');
   let live;
   try{live=await current();}catch{throw Error('SOURCE_CHANGED');}
   if(record.authorizationSnapshot!==live.record.authorizationSnapshot||record.acceptedParent!==live.record.acceptedParent||proposal.parentRevision!==live.record.revision||proposal.adultId!==live.resolved.adultId||!same(await runtime.authorize(),live.resolved.expectedAuthority))throw Error('SOURCE_CHANGED');
   let captured;
   try{captured=await captureOwnDeviceCopySet({runtime,service,sodium:s,peerId:proposal.peerId,seedId:proposal.transcript.sessionId});}
   catch(error){if(['CONFLICT','STALE_AUTHORITY'].includes(error.message))throw Error('SOURCE_CHANGED');throw error;}
   const checked=await verifyOwnDeviceSuccessor({sodium:s,provider,pin,parentRecord:live.record,next:saved.next,proposal:{hash:oob.hash,guard:proposal.guard},eventVersion:5});
   if(saved.copyHash!==captured.copyHash||checked.item.event.subject.copyHash!==captured.copyHash||!same(checked.proof.messages,messages))throw Error('SOURCE_CHANGED');
   try{must(await storage.checkSelectedHouseholdSources(captured.guard));}catch{throw Error('SOURCE_CHANGED');}
   const result=await publishOwnDeviceSet({storage,provider,sodium:s,LoroDoc,pin,parentRecord:live.record,next:saved.next,captured,
    evidence:{transcript:proposal.transcript,guard:proposal.guard,messages,hash:oob.hash},establishedEvidence:establishedProofs,keys,deviceId,signingSecret:secrets.signingSecret});
   return {...result,replayed:false};
  });
 }
 // Recover only a release bound to this completed newcomer session. The retained
 // receipt verifies every recipient ciphertext and its address on reopen.
 async function recoverPreparedSet(code){
  return withSession('initiator',async({proposal,record,oob,session})=>{
   if(code!==oob.hash||!belongs(proposal))throw Error('OOB_REQUIRED');
   const {messages}=await session.evidence();
   const saved=await read('set-preparation:'+JSON.stringify([scope.id,pin,proposal.transcript.sessionId]));
   if(!saved||!same(saved.proposal,proposal)||!same(saved.messages,messages))throw Error('INVALID_PROOF');
   const retained=await retainedSponsor(proposal);
   if(!retained)return null;
   const checked=await verifyOwnDeviceSuccessor({sodium:s,provider,pin,parentRecord:record,next:saved.next,proposal:{hash:oob.hash,guard:proposal.guard},eventVersion:5});
   if(!same(retained.item,checked.item)||!same(checked.proof.messages,messages))throw Error('INVALID_PROOF');
   return {file:retained.file,establishedRecipients:retained.establishedRecipients,head:retained.head,replayed:true};
  });
 }
 async function publish(code){
  return withSession('initiator',async({proposal,record,oob,secrets,session})=>{
   const {bundle,transcript,guard,adultId,peerId}=proposal;
   if(code!==oob.hash||!same(scope,bundle.scope)||pin!==bundle.rootPin)throw Error('OOB_REQUIRED');
   const {messages}=await session.evidence();
   const savedSet=await retainedSponsor(proposal);
   if(savedSet)return {file:savedSet.file,replayed:true,head:savedSet.head,update:''};
   const prior=must(await storage.readHouseholdOwnDeviceRelease(scope,transcript.sessionId));
   if(prior){
    const checked=await verifyOwnDeviceSuccessor({sodium:s,provider,pin,parentRecord:record,next:prior.next,proposal:{hash:oob.hash,guard}});
    verifyDeviceCopyFile(s,HOUSEHOLD_OWN_DEVICE_FILE,prior.file,oob.hash,transcript.initiator.signingPublicKey);
    if(checked.proof.guard.guardId!==prior.guardId)throw Error('CONFLICT');
    const {item,selection,head}=checked;
    return {file:prior.file,replayed:true,head,update:text({version:1,item,selection,head})};
   }
   const live=await current(), expectedAuthority=await runtime.authorize();
   if(record.authorizationSnapshot!==live.record.authorizationSnapshot||live.record.revision!==proposal.parentRevision||adultId!==live.resolved.adultId||
      !same(expectedAuthority,live.resolved.expectedAuthority))throw Error('STALE_AUTHORITY');
   if((await openSelectedRecipeCatalog(runtime)).entries.length){
    if(runtime.authority.installedSet||live.parent.runtime.acceptedRecipients.length!==1)throw Error('UNSUPPORTED_VERSION');
    const captured=await captureOwnDeviceCopySet({runtime,service,sodium:s,peerId,seedId:transcript.sessionId});
    const signed=await signCopy(live,proposal,oob,messages,5,{
     baseline:captured.set.documents[0].baseline,copyHash:captured.copyHash
    });
    const {file,head}=await publishOwnDeviceSet({storage,provider,sodium:s,LoroDoc,pin,parentRecord:live.record,next:signed.next,
     captured,evidence:{transcript,guard,messages,hash:oob.hash},keys,deviceId,signingSecret:secrets.signingSecret});
    return {file,replayed:false,head,update:''};
   }
   const documentId=live.resolved.scope.documentId, stored=must(await storage.reopenBranchDocument(expectedAuthority,documentId));
   const source={documentId,revision:stored?.revision??null,bytes:stored?.bytes??null};
   const snapshot=source.bytes??new LoroDoc().export({mode:'snapshot'});
   const retained=must(await storage.readProjectionSeed(expectedAuthority,documentId));
   const seed=retained?.seed??{seedId:transcript.sessionId,identities:[]},seedSnapshot=retained?.snapshot??null;
   const {doc,identities}=inspectOwnDeviceSnapshot({LoroDoc,snapshot,peerId,seed,seedSnapshot});
   const sources=must(await storage.readOwnDeviceSourcePolicies(expectedAuthority,documentId,identities.map(x=>x.effectId)));
   const disclosure=await service.authority(),policies=new Map();
   for(const hash of new Set(sources.flatMap(row=>row.policyHashes))){
    let next=hash;
    while(next&&!policies.has(next)){
     const policy=await service.validateStored(next,disclosure);
     policies.set(next,policy);
     next=policy.policy.predecessor;
    }
   }
   const copy={snapshot,seed,seedSnapshot,sources,policies:[...policies.values()].sort((a,b)=>a.policyHash<b.policyHash?-1:1)};
   const {item,head,next,nextState,selection}=await signCopy(live,proposal,oob,messages,4,{
    baseline:await policyBaseline(doc,provider),copyHash:ownDeviceCopyHash(s,copy),sourcesHash:ownDeviceSourcesHash(s,sources)
   });
   await verifyAuthority(nextState,pin,provider);
   const context=ownDevicePacketContext(item,oob,head);
   const packet=await keys.useIdentity({version:1,scope,deviceId,purpose:'data',epochId:context.epochId},
    key=>makeKeyPackage(s,context,key,secrets.signingSecret));
   const file=sealDeviceCopy(s,HOUSEHOLD_OWN_DEVICE_FILE,oob.hash,transcript.responder,secrets.signingSecret,
    {version:1,head,item,selection,copy,packet});
   must(await storage.commitHouseholdOwnDevice({operationId:transcript.sessionId,guardId:guard.guardId,expected:live.record,
    next,source,document:{documentId:context.projectionId,bytes:snapshot},file,sources}));
   return {file,replayed:false,head,update:text({version:1,item,selection,head})};
  });
 }
 async function signCopy(live,{transcript,guard,adultId,peerId},oob,messages,version,copy){
   const {parent,record}=live,receiver=oob.pins.responder;
   const event={version,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',householdId:scope.id,parentHead:parent.head,
    policyHash:parent.policyHash,generation:parent.generation,epochId:parent.epochId,proposalId:transcript.sessionId,
    kind:'pairOwnDevice',authorDeviceId:deviceId,frozenAdultRoster:parent.roster,nextPolicy:null,subject:{
     adultId,deviceId:receiver.deviceId,signingKeyRef:receiver.signingKey,wrappingKeyRef:receiver.wrappingKey,
     peerId,documentId:'paired-'+transcript.sessionId,parentSnapshot:record.authorizationSnapshot,parentRevision:live.record.revision,
     transcriptHash:oob.hash,...copy
    }};
   const head=s.to_hex(await provider.hash(domain('event',event)));
   const item={event,approvals:[],authorSignature:s.to_hex(await provider.sign(signingKey,domain('event-signature',event))),
    ownDevice:encodeEvidence({transcript,guard,messages})};
   const selection={from:parent.head,to:head,deviceId,index:live.state.selections.length};
   const signature=s.to_hex(await provider.sign(signingKey,domain('select-head',{root:pin,householdId:scope.id,...selection})));
   const nextState={...live.state,events:[...live.state.events,item],selections:[...live.state.selections,{...selection,signature}],activeHead:head};
   const next={scope,revision:live.record.revision+1,acceptedParent:head,authorizationSnapshot:await snapshotId(provider,nextState),authorityState:authorityBytes(nextState)};
   return {item,head,next,nextState,selection:{...selection,signature}};
 }
 async function installEstablished(file,evidence){
  if(!(file instanceof Uint8Array)||file.length>MAX_PERSONAL_PAIRING_FILE)throw Error('INVALID_FILE');
  if(!evidence?.transcript||!evidence.guard||!evidence.oob)throw Error('INVALID_PROOF');
  return withSecrets(async secrets=>{
   const session=durableSession(s,store,secrets,evidence.transcript,evidence.guard,'responder',evidence.oob);
   const completed=await session.evidence();
   if(!same(completed.messages,evidence.messages)||completed.hash!==evidence.oob.hash)throw Error('INVALID_PROOF');
   let parentRecord=must(await storage.readPairingAuthority(scope));
   if(!parentRecord)throw Error('INVALID_AUTHORITY');
   // Only a retained receipt for this exact file and proof may recover the
   // old local parent after the selected authority has advanced.
   const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(parentRecord.authorityState));
   const operation=await selectedOwnDeviceSet(parentRecord,state,provider);
   const receipt=operation&&must(await storage.readHouseholdOwnDeviceSetReceipt(scope,operation));
   if(receipt?.recipient?.kind==='established'&&receipt.recipient.deviceId===deviceId&&
      receipt.recipient.fileHash===digest(file)&&same(receipt.recipient.evidence,evidence))parentRecord=receipt.expected;
   return installEstablishedOwnDeviceSet({storage,runtime,provider,sodium:s,LoroDoc,pin,parentRecord,evidence,file,keys,deviceId,...secrets});
  });
 }
 async function install(file){
  if(!(file instanceof Uint8Array)||file.length>MAX_PERSONAL_PAIRING_FILE)throw Error('INVALID_FILE');
  file=new Uint8Array(file);
  return withSession('responder',async({proposal,record,oob,secrets,session})=>{
   const {bundle,transcript,guard}=proposal,sc=bundle.scope;
   const confirmed=(await pins.list()).find(x=>x.scope.id===sc.id);
   if(confirmed?.pin!==bundle.rootPin||confirmed.head!==record.acceptedParent)throw Error('OOB_REQUIRED');
   const evidence=await session.evidence();
   if(isOwnDeviceSetFile(s,file,oob.hash,transcript.initiator.signingPublicKey)){
    const {operationId}=householdReceiverIds(s,sc,deviceId);
    const joined={name,storage,scope:sc,pin:bundle.rootPin,provider,deviceId,operationId,confirmedParent:record.acceptedParent};
    const result=await installOwnDeviceSetFile({storage,provider,sodium:s,LoroDoc,pin:bundle.rootPin,parentRecord:record,
     evidence:{transcript,guard,messages:evidence.messages,hash:oob.hash},file,keys,deviceId,...secrets,
     prepareEnrollment:()=>prepareJoinedSequences(joined)});
    (await finalizeJoinedSequences(joined)).sequences.close();
    return result;
   }
   const contents=openDeviceCopy(s,HOUSEHOLD_OWN_DEVICE_FILE,file,oob.hash,transcript,secrets.wrappingSecret);
   if(!exact(contents,['version','head','item','selection','copy','packet'])||contents.version!==1)throw Error('INVALID_FILE');
   const {item,selection,head,copy,packet}=contents, {snapshot,seed,seedSnapshot,sources,policies}=copy;
   if(!exact(copy,['snapshot','seed','seedSnapshot','sources','policies']))throw Error('INVALID_FILE');
   const {operationId,keyOperationId}=householdReceiverIds(s,sc,deviceId);
   const prior=must(await storage.householdRecipient.find(sc.id,operationId));
   const latest=must(await storage.readPairingAuthority(sc));
   if(prior?!same(latest,prior.nextAuthority)||!same(record,prior.expectedAuthority):latest&&!same(latest,record))throw Error('STALE_AUTHORITY');
   const state=bundle.state, nextState={...state,events:[...state.events,item],selections:[...state.selections,selection],activeHead:head};
   const next={scope:sc,revision:record.revision+1,acceptedParent:head,authorizationSnapshot:await snapshotId(provider,nextState),authorityState:authorityBytes(nextState)};
   const checked=await verifyOwnDeviceSuccessor({sodium:s,provider,pin:bundle.rootPin,parentRecord:record,next,proposal:{hash:oob.hash,guard}});
   if(!same(checked.proof.messages,evidence.messages))throw Error('INVALID_PROOF');
   const {context}=checked;
   const identities=await verifyOwnDeviceCopy({sodium:s,provider,LoroDoc,copy,pin:bundle.rootPin,parentState:state,item});
   const joined={name,storage,scope:sc,pin:bundle.rootPin,provider,deviceId,operationId};
   const localIdentity={version:1,scope:sc,deviceId,purpose:'data',epochId:context.epochId};
   const result=await withOpenedKeyPackage(s,packet,context,secrets.wrappingSecret,async key=>{
    const localKey=await storage.localKeys(master,s).preparePairedDataKey(keyOperationId,localIdentity,key);
    const input={version:1,operationId,scopeId:sc.id,guardId:guard.guardId,documentId:context.projectionId,
     generation:context.generation,expectedAuthority:record,nextAuthority:next,
     manifest:{id:context.manifestHash,bytes:authorityBytes(item.event.subject)},seed,policySeed:null,snapshot,packet,localKey,
     ownDevice:{seedSnapshot,identities,sources,policies,fileHash:digest(file)}};
    const receiptBody=ownDeviceReceiptBody(s,input,context);
    const receipt=s.crypto_sign_detached(domain('household-own-device-receipt',receiptBody),secrets.signingSecret);
    await prepareJoinedSequences(joined);
    return must(await storage.householdRecipient.install({...input,receiptBody,receipt}));
   });
   const opened=await finalizeJoinedSequences(joined);
   opened.sequences.close();
   return {scope:sc,head,replayed:result.replayed};
  });
 }
 async function acceptExisting(incoming,explicit){
  const update=parse(incoming);
  if(explicit!==true||!exact(update,['version','item','selection','head'])||update.version!==1||
     !update.item?.ownDevice||!hex64(update.head))throw Error('INVALID_OWN_DEVICE');
  const {item,selection,head}=update, sponsor=item.event.authorDeviceId;
  // A completed adoption advances durable authority while the mounted runtime is stale.
  // Authenticate an exact no-write replay against that selected authority first.
  const selected=await readAuthority(storage,scope,pin,provider);
  if(head===selected.activeHead){
   const saved=must(await storage.readHouseholdOwnDeviceRelease(scope,item.event.proposalId));
   const verified=await verifyAuthority(selected.state,pin,provider), parent=verified.nodes.get(head);
   if(saved?.file===null&&saved.next.acceptedParent===head&&
      parent?.runtime.acceptedRecipients.includes(deviceId)&&sponsor!==deviceId&&item.event.subject.deviceId!==deviceId){
    const retained=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(saved.next.authorityState));
    if(same(item,retained.events.at(-1))&&same(selection,retained.selections.at(-1))&&
       same(item,selected.state.events.at(-1))&&same(selection,selected.state.selections.at(-1)))return {scope,head,replayed:true};
   }
   throw Error('STALE_AUTHORITY');
  }
  const live=await current();
  if(!live.parent.runtime.acceptedRecipients.includes(deviceId)||sponsor===deviceId||
     item.event.subject.deviceId===deviceId)throw Error('STALE_AUTHORITY');
  if(item.event.parentHead!==live.record.acceptedParent)throw Error('STALE_AUTHORITY');
  const nextState={...live.state,events:[...live.state.events,item],selections:[...live.state.selections,selection],activeHead:head};
  const next={scope,revision:live.record.revision+1,acceptedParent:head,authorizationSnapshot:await snapshotId(provider,nextState),authorityState:authorityBytes(nextState)};
  const {context,proof}=await verifyOwnDeviceSuccessor({sodium:s,provider,pin,parentRecord:live.record,next});
  const expected=await runtime.authorize(),documentId=live.parent.runtime.documentId;
  if(!same(expected,live.resolved.expectedAuthority))throw Error('STALE_AUTHORITY');
  const stored=must(await storage.reopenBranchDocument(expected,documentId));
  const doc=new LoroDoc();
  if(stored)doc.import(stored.bytes);
  // Do not switch the active document away from locally newer edits.
  const baseline=await verifyPolicyBaseline(doc,LoroDoc,item.event.subject.baseline,provider);
  if(!same(await policyBaseline(doc,provider),item.event.subject.baseline))throw Error('LOCAL_EDITS_CONFLICT');
  const retained=must(await storage.readProjectionSeed(expected,documentId));
  const snapshot=baseline.export({mode:'snapshot'});
  const {identities}=inspectOwnDeviceSnapshot({LoroDoc,snapshot,peerId:item.event.subject.peerId,
   seed:retained?.seed??{seedId:item.event.proposalId,identities:[]},seedSnapshot:retained?.snapshot??null});
  const sources=must(await storage.readOwnDeviceSourcePolicies(expected,documentId,identities.map(x=>x.effectId)));
  if(ownDeviceSourcesHash(s,sources)!==item.event.subject.sourcesHash)throw Error('SOURCE_PROVENANCE_REQUIRED');
  await keys.useIdentity({version:1,scope,deviceId,purpose:'data',epochId:context.epochId},()=>{});
  must(await storage.commitHouseholdOwnDevice({operationId:item.event.proposalId,guardId:proof.guard.guardId,expected:live.record,next,
   source:{documentId,revision:stored?.revision??null,bytes:stored?.bytes??null},
   document:{documentId:context.projectionId,bytes:snapshot},file:null,sources}));
  return {scope,head};
 }
 async function history(){
  const {current:status,verified}=await service.authority();
  const selected=verified.nodes.get(status.activeHead), ancestry=[];
  let head=status.activeHead;
  while(verified.nodes.has(head)&&head!==pin){
   const entry=status.state.events.find(item=>s.to_hex(s.crypto_generichash(32,domain('event',item.event)))===head);
   if(!entry)throw Error('INVALID_AUTHORITY');
   const {kind,subject,authorDeviceId:sponsor,parentHead}=entry.event, previous=verified.nodes.get(parentHead), child=verified.nodes.get(head);
   for(const device of child.devices){
    const before=previous.devices.find(prior=>prior.deviceId===device.deviceId);
    const action=!before?kind==='pairOwnDevice'?'Paired':kind==='recoverDevice'?'Recovered':'Admitted':
     before.active&&!device.active?'Retired':null;
    if(action)ancestry.push({action,deviceId:device.deviceId,sponsor,adultId:kind==='pairOwnDevice'?subject.adultId:device.adultId});
   }
   head=parentHead;
  }
  return {head:status.activeHead,roster:selected.roster,threshold:admissionThreshold(selected.policy,selected.roster.length),
   policy:selected.policy,devices:selected.devices,events:ancestry.reverse()};
 }
 return {deviceId,fingerprint:fingerprint(own),rootPin:pin,request,propose,inspect:async incoming=>(await inspectProposal(parse(incoming),'responder')).view,
  confirm,accept,resume,prepareSet,prepareEstablishedOffer,verifyEstablishedOffer,publishPreparedSet,recoverPreparedSet,publish,install,installEstablished,acceptExisting,history};
}
