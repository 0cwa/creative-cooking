import {domain} from '../authority/validator.mjs';
import {resolvePersonalAuthority,verifyPersonalRecord} from '../authority/personal.mjs';
import {ceremonyBytes} from '../pairing/candidate-v2.mjs';
import {durableSession} from '../pairing/durable-session.mjs';
import {openPersonalPairing} from '../pairing/personal-release.mjs';
import {
 assertContainsPersonalCopy,inspectPersonalCopy,openPersonalCopy,pairingDigest,pairingText,parsePairingText,sealPersonalCopy,verifyPersonalCopyFile,
 MAX_PERSONAL_PAIRING_FILE
} from '../pairing/personal-copy.mjs';

const scope=id=>({kind:'personal',id});
const hash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(value);
const peer=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value)&&BigInt(value)<18446744073709551615n;
const exact=(value,fields)=>!!value&&typeof value==='object'&&Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
const must=result=>{if(!result.ok)throw Error(result.error.code??result.error);return result.value};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const roles=['initiator','responder'];

/** A local Settings ceremony. Public messages are interchangeable through any
 * channel. Device fingerprints, the root pin and the transcript comparison are
 * entered separately on each device and retained only after checking. */
export function personalPairing({sodium:s,storage,recipient,store,provider,master,keys,signing,wrapping,
 signingKey,wrappingKey,deviceId,original,selected,selection,LoroDoc,randomUUID=()=>crypto.randomUUID()}){
 const own={deviceId,signingKey,wrappingKey};
 const digest=bytes=>pairingDigest(s,bytes);
 const pinFingerprint=bundle=>digest(domain('personal-device-fingerprint',[bundle.deviceId,bundle.signingKey,bundle.wrappingKey]));
 const requestBytes=request=>domain('personal-device-request',[request.deviceId,request.signingKey,request.wrappingKey,request.nonce,request.peerId]);
 const withKeys=use=>keys.use(signing.operationId,signing.identity,signingSecret=>
  keys.use(wrapping.operationId,wrapping.identity,wrappingSecret=>use({signingSecret,wrappingSecret})));
 const slot=key=>'personal-device-pairing/v1:'+key;
 const read=key=>store.transaction(tx=>tx.get(slot(key)),{readOnly:true});
 const write=(key,value,previous)=>store.transaction(tx=>{
  if(!same(tx.get(slot(key)),previous))throw Error('CONFLICT');
  tx.put(slot(key),value);
  return value;
 });
 const resolve=(target,author=deviceId)=>resolvePersonalAuthority(storage,scope(target.scopeId),target.pin,provider,author);
 async function authority(target){
  const resolved=await resolve(target),record=must(await storage.readPairingAuthority(scope(target.scopeId)));
  if(record?.authorizationSnapshot!==resolved.scope.authorizationSnapshot||record.revision!==resolved.expectedAuthority.record.revision)throw Error('CONFLICT');
  return {resolved,record};
 }
 const participant=(role,bundle,nonce)=>({role,deviceId:bundle.deviceId,signingPublicKey:s.from_hex(bundle.signingKey),
  wrappingPublicKey:s.from_hex(bundle.wrappingKey),nonce:s.from_hex(nonce)});
 const bundle=value=>({deviceId:value.deviceId,signingKey:s.to_hex(value.signingPublicKey),wrappingKey:s.to_hex(value.wrappingPublicKey)});
 const signal=context=>domain('personal-device-ceremony',[context.rootPin,context.ownerId,context.parentRevision,context.requestHash,context.peerId]);
 const code=proposal=>digest(ceremonyBytes(proposal.transcript,proposal.guard));
 const remoteRole=role=>role==='initiator'?'responder':'initiator';

 async function request(renew=false){
  const old=await read('request');
  if(old&&!renew)return pairingText(s,old);
  if(selected.scopeId!==original.scopeId)throw Error('ORIGINAL_REQUIRED');
  let peerId;
  do {peerId=String(BigInt('0x'+s.to_hex(s.randombytes_buf(8))));} while(!peer(peerId));
  const request={...own,nonce:s.to_hex(s.randombytes_buf(32)),peerId};
  const item={request,signature:s.to_hex(await provider.sign(signingKey,requestBytes(request)))};
  return store.transaction(tx=>{
   if(!same(tx.get(slot('request')),old))throw Error('CONFLICT');
   tx.put(slot('request'),item);
   if(renew)tx.put(slot('responder'),null);
   return pairingText(s,item);
  });
 }
 async function requestInfo(text){
  const item=parsePairingText(s,text),r=item?.request;
  if(!exact(item,['request','signature'])||!exact(r,['deviceId','signingKey','wrappingKey','nonce','peerId'])||
   !id(r.deviceId)||!hash(r.signingKey)||!hash(r.wrappingKey)||!hash(r.nonce)||!peer(r.peerId)||
   typeof item.signature!=='string'||!/^[0-9a-f]{128}$/.test(item.signature)||
   !await provider.verify(r.signingKey,requestBytes(r),s.from_hex(item.signature)))throw Error('INVALID_REQUEST');
  return {request:r,requestHash:digest(requestBytes(r)),fingerprint:pinFingerprint(r)};
 }
 async function propose(text,peerFingerprint){
  const {request:r,requestHash,fingerprint}=await requestInfo(text),old=await read('initiator');
  if(fingerprint!==peerFingerprint)throw Error('OOB_REQUIRED');
  if(old?.proposal.context.requestHash===requestHash&&old.proposal.transcript.scope.id===selected.scopeId){
   if(old.peerFingerprint!==peerFingerprint)throw Error('OOB_REQUIRED');
   return proposalView(old.proposal,'initiator');
  }
  const {resolved,record}=await authority(selected);
  if(resolved.signingKeyRefs[deviceId]!==signingKey||r.wrappingKey===wrappingKey||
   resolved.rotation?.seedPeerId===r.peerId||resolved.devices.some(d=>d.deviceId===r.deviceId||d.signingKeyRef===r.signingKey||d.peerId===r.peerId))throw Error('UNAUTHORIZED');
  const context={rootPin:selected.pin,ownerId:resolved.scope.ownerId,parentRevision:record.revision,requestHash,peerId:r.peerId};
  const transcript={version:1,sessionId:randomUUID(),action:'pairOwnDevice',scope:record.scope,purpose:'data',
   acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot,
   initiator:participant('initiator',own,s.to_hex(s.randombytes_buf(32))),responder:participant('responder',r,r.nonce),
   signaling:[signal(context)]};
  const guard={version:1,guardId:randomUUID(),scope:record.scope,direction:'initiator-to-responder',purpose:'data'};
  const proposal={version:1,context,transcript,guard};
  code(proposal);
  await write('initiator',{proposal,peerFingerprint,confirmed:false},old);
  return proposalView(proposal,'initiator');
 }
 function proposalView(proposal,role){
  return {text:pairingText(s,proposal),code:code(proposal),rootPin:proposal.context.rootPin,ownerId:proposal.context.ownerId,
   peerDevice:proposal.transcript[remoteRole(role)].deviceId};
 }
 function matchesRequest(proposal,item){
  const {context,transcript}=proposal;
  return item&&context.requestHash===digest(requestBytes(item.request))&&context.peerId===item.request.peerId&&
   s.to_hex(transcript.responder.nonce)===item.request.nonce;
 }
 async function inspect(text){
  const proposal=parsePairingText(s,text),c=proposal?.context,t=proposal?.transcript,g=proposal?.guard;
  if(!exact(proposal,['version','context','transcript','guard'])||proposal.version!==1||
   !exact(c,['rootPin','ownerId','parentRevision','requestHash','peerId'])||!hash(c.rootPin)||!id(c.ownerId)||
   !hash(c.requestHash)||!peer(c.peerId)||!Number.isSafeInteger(c.parentRevision)||c.parentRevision<0)throw Error('INVALID_PROOF');
  code(proposal);
  if(t.action!=='pairOwnDevice'||t.scope.kind!=='personal'||t.scope.id===original.scopeId||
   t.purpose!=='data'||g.direction!=='initiator-to-responder'||t.signaling.length!==1||
   s.to_hex(t.signaling[0])!==s.to_hex(signal(c))||t.responder.deviceId!==deviceId||
   pinFingerprint(bundle(t.responder))!==pinFingerprint(own))throw Error('UNAUTHORIZED');
  const item=await read('request');
  if(!matchesRequest(proposal,item))throw Error('UNAUTHORIZED');
  return {proposal,item};
 }
 async function confirm(role,text,peerFingerprint,rootPin,transcriptCode){
  if(!roles.includes(role))throw Error('UNAUTHORIZED');
  const old=await read(role);
  const {proposal,item}=role==='initiator'?{proposal:old?.proposal}:await inspect(text);
  if(!proposal||code(proposal)!==transcriptCode||proposal.context.rootPin!==rootPin||
   pinFingerprint(bundle(proposal.transcript[remoteRole(role)]))!==peerFingerprint||
   (role==='initiator'&&old.peerFingerprint!==peerFingerprint))throw Error('OOB_REQUIRED');
  if(role==='responder'){
   const current=must(await storage.readPersonalSelection(deviceId));
   if(current&&!same(current,original)&&!same(current,{scopeId:proposal.transcript.scope.id,pin:rootPin}))throw Error('ORIGINAL_REQUIRED');
  }
  const saved={proposal,peerFingerprint,confirmed:true};
  if(role==='responder'){
   await store.transaction(tx=>{
    if(!same(tx.get(slot(role)),old)||!same(tx.get(slot('request')),item))throw Error('CONFLICT');
    if(!same(old,saved))tx.put(slot(role),saved);
   });
  }else if(!same(old,saved))await write(role,saved,old);
  return progress(role);
 }
 async function withSession(role,use){
  if(!roles.includes(role))throw Error('UNAUTHORIZED');
  const saved=await read(role);
  if(!saved?.confirmed)throw Error('OOB_REQUIRED');
  const {proposal,peerFingerprint}=saved,{context,transcript,guard}=proposal;
  const pins=Object.fromEntries(roles.map(role=>[role,bundle(transcript[role])]));
  if(pinFingerprint(pins[role])!==pinFingerprint(own)||pinFingerprint(pins[remoteRole(role)])!==peerFingerprint)throw Error('OOB_REQUIRED');
  const oob={hash:code(proposal),pins};
  const sessionStore=role==='responder'?{
   transaction:(apply,options)=>store.transaction(tx=>{
    if(!same(tx.get(slot(role)),saved)||!matchesRequest(proposal,tx.get(slot('request'))))throw Error('CONFLICT');
    return apply(tx);
   },options)
  }:store;
  return withKeys(secrets=>use({proposal,context,transcript,guard,oob,secrets,sessionStore,
   session:durableSession(s,sessionStore,secrets,transcript,guard,role,oob)}));
 }
 async function progress(role){
  return withSession(role,async({session})=>{
   await session.initialize();
   const {offer,response,ack,complete}=await session.outgoing();
   return {complete,text:pairingText(s,{offer,response,ack}),stage:ack?'Acknowledgement':response?'Response':'Challenge'};
  });
 }
 async function accept(role,text){
  const message=parsePairingText(s,text);
  if(!exact(message,['offer','response','ack'])||!exact(message.offer,['role','hash','challenge','signature'])||
   !(message.response===null||exact(message.response,['role','hash','offer','token','signature']))||
   !(message.ack===null||exact(message.ack,['role','hash','response','signature']))||
   (message.ack&&!message.response))throw Error('INVALID_PROOF');
  await withSession(role,async({session})=>{
   await session.initialize();
   const {revision}=await session.outgoing();
   await session.respond(message.offer,revision);
   if(message.response)await session.acknowledge(message.response,revision+1);
   if(message.ack)await session.finish(message.ack,revision+2);
  });
  return progress(role);
 }
 function ceremony(args,role,offeredParent){
  const {transcript,guard,oob,secrets,context,sessionStore}=args;
  return openPersonalPairing({sodium:s,storage,sessionStore,keys:secrets,transcript,guard,role,oob,
   rootPin:context.rootPin,ownerId:context.ownerId,provider,offeredParent});
 }
 async function publish(){
  return withSession('initiator',async args=>{
   const {context,transcript,oob,secrets}=args;
   if(transcript.scope.id!==selected.scopeId||context.rootPin!==selected.pin)throw Error('UNAUTHORIZED');
   if(!same(must(await storage.readPersonalSelection(deviceId)),selection))throw Error('CONFLICT');
   const opened=await ceremony(args,'initiator'),resolved=await resolve(selected);
   const identity={version:1,scope:transcript.scope,deviceId,purpose:'data',epochId:resolved.scope.epochId};
   const {file,replayed,authorizationSnapshot}=await opened.release(transcript.sessionId,keys,null,identity,context.peerId,async(envelope,authorized,expected)=>{
    if(expected.revision!==context.parentRevision)throw Error('CONFLICT');
    const {documentId,documentGeneration,epochId}=authorized.scope;
    const stored=must(await storage.reopenBranchDocument(authorized.expectedAuthority,documentId));
    const bytes=stored?.bytes??null;
    const source={documentId,revision:stored?.revision??null,bytes};
    const {frontier,hash}=inspectPersonalCopy(LoroDoc,s,bytes,context.peerId);
    const document={...source,frontier,hash,generation:documentGeneration,epochId};
    return {expected,source,file:sealPersonalCopy(s,oob.hash,transcript.responder,secrets.signingSecret,{version:1,parent:expected,envelope,document})};
   },selection);
   verifyPersonalCopyFile(s,file,oob.hash,transcript.initiator.signingPublicKey);
   return {file,replayed,scopeId:transcript.scope.id,head:transcript.acceptedParent,authorizationSnapshot};
  });
 }
 async function install(file){
  if(!(file instanceof Uint8Array)||file.length>MAX_PERSONAL_PAIRING_FILE)throw Error('INVALID_FILE');
  file=new Uint8Array(file);
  return withSession('responder',async args=>{
   const {context,transcript,oob,secrets}=args;
   const contents=openPersonalCopy(s,file,oob.hash,transcript,secrets.wrappingSecret);
   if(!exact(contents,['version','parent','envelope','document']))throw Error('INVALID_FILE');
   const {version,parent,envelope,document}=contents;
   try{
    if(version!==1||!parent||parent.revision!==context.parentRevision||
      !exact(document,['documentId','revision','bytes','frontier','hash','generation','epochId'])||
      envelope?.release?.operationId!==transcript.sessionId||envelope?.admission?.admission?.peerId!==context.peerId)throw Error('INVALID_FILE');
    const opened=await ceremony(args,'responder',parent);
    const result=await opened.install(envelope,recipient,master,'workspace-master','personal-data:'+envelope.release.packet.id,async(authorized,change,replayed)=>{
     const a=authorized.scope;
     if(document.documentId!==a.documentId||document.epochId!==a.epochId||document.generation!==a.documentGeneration||
      !(document.revision===null?document.bytes===null:Number.isSafeInteger(document.revision)&&document.revision>=0&&document.bytes instanceof Uint8Array))throw Error('INVALID_FILE');
     const checked=inspectPersonalCopy(LoroDoc,s,document.bytes,context.peerId);
     if(document.hash!==checked.hash||!same(document.frontier,checked.frontier))throw Error('INVALID_FILE');
     const current=must(await storage.readPersonalSelection(deviceId));
     if(current&&!same(current,original)&&!same(current,{scopeId:transcript.scope.id,pin:context.rootPin}))throw Error('ORIGINAL_REQUIRED');
     let latest;
     if(replayed){
      const checkedCurrent=must(await storage.reopenBranchDocument({version:2,scope:change.next.scope,record:change.next},a.documentId));
      assertContainsPersonalCopy(LoroDoc,document.bytes,checkedCurrent?.bytes);
      latest=checkedCurrent;
     }
     // The workspace's prior selection is a CAS condition even across tabs.
     return {documentId:document.documentId,revision:document.revision,bytes:document.bytes,fileHash:digest(file),
      pin:context.rootPin,identities:checked.identities,selection:current,latest};
    });
    return {replayed:result.replayed,scopeId:transcript.scope.id,head:result.head,authorizationSnapshot:result.authorizationSnapshot};
   }finally{if(document?.bytes instanceof Uint8Array)document.bytes.fill(0)}
  });
 }
 async function resume(role){
  const saved=await read(role);
  if(!saved)return null;
  return {...proposalView(saved.proposal,role),peerFingerprint:saved.peerFingerprint,confirmed:saved.confirmed,
   progress:saved.confirmed?await progress(role):null};
 }
 async function history(){
  const {resolved,record}=await authority(selected);
  const {state}=await verifyPersonalRecord(record,record.scope,selected.pin,provider);
  const base=state.version===3?state.base:state;
  const root=base.version===2?base.rootState.root:base.root;
  const events=[...(base.admissions??[]),...(state.events??[])].flatMap(item=>item.admission?[
   {deviceId:item.admission.recipientDeviceId,sponsor:item.admission.sponsorDeviceId,action:'Paired'}
  ]:[
   ...item.rotation.recipients.map(d=>({deviceId:d.deviceId,sponsor:item.rotation.sponsorDeviceId,action:'Key updated'})),
   ...item.rotation.retiredDevices.map(deviceId=>({deviceId,sponsor:item.rotation.sponsorDeviceId,action:'Retired'}))
  ]);
  return {ownerId:resolved.scope.ownerId,pin:selected.pin,rootDevice:root.signerDeviceId,
   devices:resolved.devices.map(d=>({deviceId:d.deviceId,active:d.active,local:d.deviceId===deviceId})),events};
 }
 async function returnToOriginal(){
  if(!selection||selected.scopeId===original.scopeId)throw Error('CONFLICT');
  const {record}=await authority(original);
  must(await storage.selectOriginalPersonal(deviceId,selection,record,original.pin));
  return {scopeId:original.scopeId,head:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot};
 }
 return {deviceId,fingerprint:pinFingerprint(own),rootPin:selected.pin,request,requestInfo,propose,
  inspect:async text=>proposalView((await inspect(text)).proposal,'responder'),confirm,accept,resume,publish,install,history,
  usingOriginal:selected.scopeId===original.scopeId,returnToOriginal};
}
