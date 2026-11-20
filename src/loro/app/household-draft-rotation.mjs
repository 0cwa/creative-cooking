import {authorityBytes} from '../authority/chain.mjs';
import {domain,remainingRotationDevices} from '../authority/validator.mjs';
import {validatePairingAuthority} from '../contracts/pairing.ts';
import {deriveDraftRotationBinding} from '../compromise/checked-draft-source.mjs';
import {verifyDraftRotationGrant} from '../compromise/draft-rotation-grant.mjs';
import {prepareDraftRotationManifest} from '../compromise/draft-rotation-manifest.mjs';
import {checkRecipientBinding,digest,exact,grantBody,hex} from '../compromise/revocation.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {requirePublicRecipeHistory} from '../projection/current-document-set.mjs';

const same=(a,b)=>hex(authorityBytes(a))===hex(authorityBytes(b));

/** Public proposal review. The saved draft stays in local storage and is
 * recovered by its ID when a publisher rebuilds the signed commitments. */
export function householdDraftRotation({storage,scope,pin,provider,sodium,runtime,deviceId,adultId,signingKey,randomUUID,revocation}){
 const household=structuredClone(scope);
 const sign=async (purpose,body)=>hex(await provider.sign(signingKey,domain(purpose,body)));

 async function current(){
  const authority=runtime.authority;
  if(!authority||runtime.storage!==storage||authority.rootPin!==pin||authority.provider!==provider||
     authority.activatedPolicy||authority.returnedPolicy||authority.adultRemoval||authority.draftRotation||
     authority.installedSet?.paired||runtime.scope.scopeId!==household.id||runtime.scope.authorDevice!==deviceId)throw Error('UNSUPPORTED_VERSION');
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
  const confirmation=await digest(provider,'draft-rotation-set-review-v1',{eventHash:checked.eventHash,grantHash:checked.grantHash});
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
 return {prepare,review,approve,binding};
}
