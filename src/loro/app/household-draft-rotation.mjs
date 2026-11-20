import {authorityBytes} from '../authority/chain.mjs';
import {domain,remainingRotationDevices} from '../authority/validator.mjs';
import {validatePairingAuthority} from '../contracts/pairing.ts';
import {deriveDraftRotationBinding,retainedDraftRotationBinding} from '../compromise/checked-draft-source.mjs';
import {verifyDraftRotationGrant} from '../compromise/draft-rotation-grant.mjs';
import {prepareDraftRotationManifest} from '../compromise/draft-rotation-manifest.mjs';
import {checkRecipientBinding,digest,exact,grantBody,hex} from '../compromise/revocation.mjs';
import {publishDraftRotation} from '../compromise/publish-draft-rotation.mjs';
import {releaseDraftRotation,reopenDraftRotationSponsor} from '../compromise/release-draft-rotation.mjs';
import {verifyDraftRotationRelease} from '../compromise/open-draft-rotation.mjs';
import {installDraftRotationRelease} from '../compromise/install-draft-rotation.mjs';
import {decodeDraftRotationRelease,encodeDraftRotationRelease} from '../pairing/draft-rotation-wire.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {requirePublicRecipeHistory} from '../projection/current-document-set.mjs';
import {selectedSourceHash} from '../projection/selected-sources.mjs';

const same=(a,b)=>hex(authorityBytes(a))===hex(authorityBytes(b));

/** Public proposal review. The saved draft stays in local storage and is
 * recovered by its ID when a publisher rebuilds the signed commitments. */
export function householdDraftRotation({storage,scope,pin,provider,sodium,runtime,deviceId,adultId,signingKey,randomUUID,revocation,LoroDoc,keys,withSecrets}){
 const household=structuredClone(scope);
 const sign=async (purpose,body)=>hex(await provider.sign(signingKey,domain(purpose,body)));

 function mountedAuthority(){
  const authority=runtime.authority;
  if(!authority||runtime.storage!==storage||authority.rootPin!==pin||authority.provider!==provider||
     runtime.scope.scopeId!==household.id||runtime.scope.authorDevice!==deviceId)throw Error('UNSUPPORTED_VERSION');
  return authority;
 }

 function mutableContext(){
  const authority=mountedAuthority();
  if(authority.activatedPolicy||authority.returnedPolicy||authority.adultRemoval||authority.draftRotation||
     authority.installedSet?.paired)throw Error('UNSUPPORTED_VERSION');
 }

 async function current(){
  mutableContext();
  const verified=await verifyPublicParent(storage,household,pin,provider);
  const parent=verified.nodes.get(verified.state.activeHead);
  const {record}=verified,authorized=await runtime.authorize();
  if(!same(authorized.scope,household)||!same(authorized.record,{revision:record.revision,acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot})||
     runtime.scope.branchHead!==record.acceptedParent)throw Error('STALE_AUTHORITY');
  const local=parent.devices.find(device=>device.active&&device.deviceId===deviceId&&device.adultId===adultId);
  if(!local||local.signingKeyRef!==signingKey)throw Error('INVALID_AUTHORITY');
  return {...verified,parent};
 }

 async function unchanged(record){
  const latest=await storage.readPairingAuthority(household);
  if(!latest.ok||!same(latest.value,record))throw Error('STALE_AUTHORITY');
 }

 async function proposalParent(local,publisherParent){
  if(publisherParent===undefined)return local;
  if(!validatePairingAuthority(publisherParent).ok||!same(publisherParent.scope,household))throw Error('INVALID_PARENT');
  const view={readPairingAuthority:async()=>({ok:true,value:publisherParent})};
  const verified=await verifyPublicParent(view,household,pin,provider),parent=verified.nodes.get(verified.state.activeHead);
  if(!same(parent,local.parent))throw Error('INVALID_PARENT');
  return {...verified,parent};
 }

 async function inspect(proposal,context){
  if(!exact(proposal,'item,grant,manifest,recipientBindings'))throw Error('INVALID_PROPOSAL');
  const checked=await verifyDraftRotationGrant({provider,pin,...context,...proposal,requireQuorum:false});
  requirePublicRecipeHistory(context.state,new Set(proposal.manifest.entries.map(entry=>entry.recipeId)));
  const confirmation=await proposalConfirmation(checked.eventHash,checked.grantHash);
  const approved=proposal.item.approvals.map(({adultId,deviceId})=>({adultId,deviceId}));
  return {...checked,confirmation,parentHead:context.parent.head,suspectDevice:proposal.item.event.subject.deviceId,
   recipients:proposal.grant.recipients.slice(),approved,canApprove:!approved.some(vote=>vote.adultId===adultId)};
 }

 async function prepare({draftId,bindings,explicit}){
  if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');
  if(!Array.isArray(bindings)||bindings.length>127)throw Error('INVALID_RECIPIENT');
  bindings=structuredClone(bindings);
  const context=await current(),{parent}=context;
  const binding=await deriveDraftRotationBinding(runtime,draftId),suspectDevice=binding.suspectDevice;
  if(binding.sourceHead!==parent.head||suspectDevice===deviceId||!parent.devices.some(d=>d.active&&d.deviceId===suspectDevice))throw Error('INVALID_DRAFT_SOURCE');
  const devices=remainingRotationDevices(parent,{kind:'revokeDevice',subject:{deviceId:suspectDevice}});
  const expected=new Set(devices.map(device=>device.deviceId)),supplied=new Map();
  for(const value of [...bindings,await revocation.binding()]){
   const {deviceId:id}=await checkRecipientBinding(parent,value,provider);
   if(!expected.has(id)||supplied.has(id))throw Error('INVALID_RECIPIENT');
   supplied.set(id,value);
  }
  if(supplied.size!==expected.size)throw Error('RECIPIENT_BINDINGS_REQUIRED');
  const peers=new Set(Object.values(parent.runtime.authorPeers));
  const freshPeer=()=>{
   for(let attempt=0;attempt<32;attempt++){
    const peer=BigInt('0x'+hex(sodium.randombytes_buf(8))).toString();
    if(peer!=='0'&&!peers.has(peer)){peers.add(peer);return peer;}
   }
   throw Error('PEER_GENERATION_FAILED');
  };
  const event={version:2,suiteId:runtime.scope.suiteId,householdId:household.id,parentHead:parent.head,
   proposalId:randomUUID(),kind:'revokeDevice',authorDeviceId:deviceId,policyHash:parent.policyHash,
   generation:parent.generation,epochId:parent.epochId,frozenAdultRoster:parent.roster,nextPolicy:null,
   subject:{deviceId:suspectDevice,documentId:randomUUID(),newEpochId:randomUUID(),newGeneration:parent.generation+1,
    devices:devices.map(({deviceId,signingKeyRef})=>({deviceId,signingKeyRef,wrappingKeyRef:supplied.get(deviceId).wrappingKey,peerId:freshPeer()}))}};
  const item={event,authorSignature:await sign('event-signature',event),approvals:[]};
  const projected=await prepareDraftRotationManifest({runtime,binding,item,allocateSeed:()=>({seedId:randomUUID(),peerId:freshPeer()})});
  const {subject}=event,recipients=subject.devices.map(d=>d.deviceId);
  const grant={version:1,householdId:household.id,parentHead:parent.head,eventHash:projected.eventHash,manifestHash:projected.manifestHash,
   newEpochId:subject.newEpochId,newGeneration:subject.newGeneration,documentId:subject.documentId,recipients,
   packageRefs:recipients.map(()=>randomUUID()),contentClasses:['pantry','recipe','shopping'],disclosure:'current-state-only',signatures:[]};
  const proposal={item,grant,manifest:projected.manifest,recipientBindings:recipients.map(id=>supplied.get(id))};
  const checked=await inspect(proposal,context);
  await unchanged(context.record);
  const source=await storage.checkSelectedHouseholdSources(projected.source);
  if(!source.ok)throw Error('STALE_SOURCE');
  return {proposal,publisherParent:context.record,...checked};
 }

 async function review({proposal,publisherParent}){
  ({proposal,publisherParent}=structuredClone({proposal,publisherParent}));
  const local=await current(),context=await proposalParent(local,publisherParent);
  const checked=await inspect(proposal,context);
  await unchanged(local.record);
  return checked;
 }

 async function approve({proposal,publisherParent,confirmed,explicit}){
  if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');
  ({proposal,publisherParent}=structuredClone({proposal,publisherParent}));
  const local=await current(),context=await proposalParent(local,publisherParent);
  const checked=await inspect(proposal,context);
  if(confirmed!==checked.confirmation)throw Error('REVIEW_CHANGED');
  if(!checked.canApprove)throw Error('ALREADY_APPROVED');
  const event=proposal.item.event,voter={adultId,deviceId};
  const approval={version:1,householdId:household.id,eventHash:checked.eventHash,parentHead:event.parentHead,
   policyHash:event.policyHash,generation:event.generation,epochId:event.epochId,...voter};
  const bindingsHash=await digest(provider,'draft-rotation-recipient-bindings-v1',proposal.recipientBindings);
  proposal.item.approvals.push({...approval,signature:await sign('approval-signature',approval)});
  proposal.grant.signatures.push({...voter,signature:await sign('draft-rotation-set-grant-vote-v1',
   {grant:grantBody(proposal.grant),bindingsHash,...voter})});
  const result=await inspect(proposal,context);
  await unchanged(local.record);
  return {proposal,publisherParent:context.record,...result};
 }

 async function binding(){
  const context=await current(),value=await revocation.binding();
  await checkRecipientBinding(context.parent,value,provider);
  await unchanged(context.record);
  return value;
 }

 const options={storage,scope:household,pin,provider,sodium,LoroDoc,keys};
 const sponsorOptions=operationId=>({...options,deviceId,operationId});
 const recipientOptions={...options,recipientDeviceId:deviceId,recipientAdultId:adultId};
 const proposalConfirmation=(eventHash,grantHash)=>digest(provider,'draft-rotation-set-review-v1',{eventHash,grantHash});

 async function proposalHashes(proposal){
  if(!exact(proposal,'item,grant,manifest,recipientBindings'))throw Error('INVALID_PROPOSAL');
  const eventHash=await digest(provider,'event',proposal.item.event);
  const bindingsHash=await digest(provider,'draft-rotation-recipient-bindings-v1',proposal.recipientBindings);
  const grantHash=await digest(provider,'draft-rotation-set-grant-v1',{grant:grantBody(proposal.grant),bindingsHash});
  return {eventHash,grantHash};
 }

 async function publish({draftId,proposal,confirmed,explicit}){
  if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');
  mutableContext();
  const {eventHash,grantHash}=await proposalHashes(proposal);
  const {event}=proposal.item,operationId=event.proposalId;
  if(confirmed!==await proposalConfirmation(eventHash,grantHash)||runtime.scope.branchHead!==event.parentHead||
     event.authorDeviceId!==deviceId)throw Error('REVIEW_CHANGED');
  async function retained(){
   const found=await storage.readDraftRotationPublication(household.id,operationId);
   if(!found.ok)throw Error('INVALID_RECEIPT');
   if(!found.value)return null;
   const verified=await reopenDraftRotationSponsor({...sponsorOptions(operationId),expectedProposal:proposal});
   const binding=await retainedDraftRotationBinding(storage,household.id,draftId);
   if(await selectedSourceHash(provider,'draft-rotation-binding-v1',binding)!==proposal.manifest.draftBindingHash)throw Error('RETRY_MISMATCH');
   await unchanged(verified.record);
   return {operationId,head:verified.record.acceptedParent};
  }
  const saved=await retained();
  if(saved)return saved;
  try{
   const checked=await review({proposal});
   if(!checked.complete||checked.confirmation!==confirmed)throw Error('REVIEW_CHANGED');
   const binding=await deriveDraftRotationBinding(runtime,draftId);
   return await publishDraftRotation({runtime,sodium,keys,signingKey,
    withSigningSecret:use=>withSecrets(({signingSecret})=>use(signingSecret)),binding,proposal,
    confirmation:{explicit:true,eventHash,grantHash}});
  }catch(error){
   const recovered=await retained();
   if(recovered)return recovered;
   throw error;
  }
 }

 async function authorizeSponsor(operationId){
  const mounted=mountedAuthority().draftRotation;
  if(mounted){
   if(mounted.options.role!=='sponsor'||mounted.options.operationId!==operationId)throw Error('INVALID_RECIPIENT');
   await runtime.authorize();
  }else mutableContext();
  const verified=await reopenDraftRotationSponsor(sponsorOptions(operationId));
  if(!mounted&&runtime.scope.branchHead!==verified.parentHead)throw Error('STALE_AUTHORITY');
  return verified;
 }

 async function status(operationId=mountedAuthority().draftRotation?.options.operationId){
  if(!operationId)throw Error('INVALID_RECEIPT');
  const verified=await authorizeSponsor(operationId);
  return {operationId,head:verified.record.acceptedParent,recipients:verified.child.runtime.acceptedRecipients.filter(id=>id!==deviceId)};
 }

 async function exportFile({operationId,recipientDeviceId}){
  await authorizeSponsor(operationId);
  return encodeDraftRotationRelease(await releaseDraftRotation({...sponsorOptions(operationId),recipientDeviceId}));
 }

 const fileConfirmation=(file,sourceRevision,eventHash,grantHash)=>digest(provider,'draft-rotation-file-review-v1',
  {scope:household,deviceId,sourceRevision,eventHash,grantHash,fileHash:hex(sodium.crypto_generichash(32,file))});

 async function inspectFile(file,release,local){
  const sourceRevision=local.record.revision;
  const {checked}=await verifyDraftRotationRelease({...recipientOptions,release,expectedRevision:sourceRevision});
  const {eventHash,grantHash}=checked;
  const confirmation=await fileConfirmation(file,sourceRevision,eventHash,grantHash);
  await unchanged(local.record);
  return {eventHash,grantHash,confirmation,sourceRevision,parentHead:local.parent.head,
   operationId:release.proposal.item.event.proposalId,suspectDevice:release.proposal.item.event.subject.deviceId};
 }

 async function reviewFile({file}){
  const release=decodeDraftRotationRelease(file);
  return inspectFile(file,release,await current());
 }

 async function install({file,confirmed,sourceRevision,explicit}){
  if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');
  mutableContext();
  const release=decodeDraftRotationRelease(file),{proposal}=release;
  const {eventHash,grantHash}=await proposalHashes(proposal);
  if(runtime.scope.branchHead!==proposal.item.event.parentHead||!Number.isSafeInteger(sourceRevision)||sourceRevision<0||
     confirmed!==await fileConfirmation(file,sourceRevision,eventHash,grantHash))throw Error('REVIEW_CHANGED');
  const saved=await storage.readDraftRotationRecipient(household.id,proposal.item.event.proposalId);
  if(!saved.ok)throw Error('INVALID_RECEIPT');
  if(!saved.value){
   const checked=await inspectFile(file,release,await current());
   if(checked.confirmation!==confirmed||checked.sourceRevision!==sourceRevision)throw Error('REVIEW_CHANGED');
  }
  return withSecrets(({signingSecret,wrappingSecret})=>installDraftRotationRelease({...recipientOptions,release,wrappingSecret,
   signSelection:bytes=>sodium.crypto_sign_detached(bytes,signingSecret),
   confirmedHead:eventHash,confirmedGrantHash:grantHash,expectedRevision:sourceRevision}));
 }

 return {prepare,review,approve,binding,publish,status,exportFile,reviewFile,install};
}
