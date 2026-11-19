import {authorityBytes,snapshotId} from '../authority/chain.mjs';
import {validatePairingAuthority} from '../contracts/pairing.ts';
import {domain,removedDevice} from '../authority/validator.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {prepareAdultRemovalDocumentSet} from '../projection/current-document-set.mjs';
import {verifyAdultRemovalGrant} from '../compromise/adult-removal-grant.mjs';
import {publishAdultRemovalDocumentSet} from '../compromise/publish-adult-removal-set.mjs';
import {releaseAdultRemoval,reopenAdultRemovalSponsor} from '../compromise/release-adult-removal.mjs';
import {installAdultRemovalRelease} from '../compromise/install-adult-removal.mjs';
import {verifyAdultRemovalFileAddress} from '../compromise/open-adult-removal.mjs';
import {digest,exact,grantBody,hex} from '../compromise/revocation.mjs';

const same=(a,b)=>hex(authorityBytes(a))===hex(authorityBytes(b));

/** Scoped complete-set removal workflow; preparation exposes no snapshots. */
export function householdAdultRemoval({storage,scope,pin,provider,sodium,runtime,service,deviceId,adultId,signingKey,randomUUID,revocation,keys,withSecrets,LoroDoc}) {
 const capturedScope=structuredClone(scope);
 function mutableContext() {
  const authority=runtime.authority;
  if(!authority||runtime.storage!==storage||authority.rootPin!==pin||authority.provider!==provider||authority.activatedPolicy||authority.returnedPolicy||authority.adultRemoval||authority.installedSet?.paired||runtime.scope.scopeId!==capturedScope.id||runtime.scope.authorDevice!==deviceId)throw Error('UNSUPPORTED_VERSION');
 }
 async function parent() {
  mutableContext();
  const current=await verifyPublicParent(storage,capturedScope,pin,provider), selected=current.nodes.get(current.state.activeHead);
  const authorized=await runtime.authorize();
  if(!same(authorized.scope,capturedScope)||authorized.record.revision!==current.record.revision||authorized.record.acceptedParent!==current.record.acceptedParent||authorized.record.authorizationSnapshot!==current.record.authorizationSnapshot||runtime.scope.branchHead!==current.record.acceptedParent)throw Error('STALE_AUTHORITY');
  const local=selected.devices.find(d=>d.active&&d.deviceId===deviceId&&d.adultId===adultId);
  if(!local||local.signingKeyRef!==signingKey)throw Error('INVALID_AUTHORITY');
  return {...current,parent:selected,local};
 }
 async function unchanged(record) {
  const current=await parent();
  if(!same(current.record,record))throw Error('STALE_AUTHORITY');
 }
 async function inspect(proposal,context) {
  if(!exact(proposal,'item,grant,manifest,recipientBindings'))throw Error('INVALID_PROPOSAL');
  const checked=await verifyAdultRemovalGrant({provider,pin,...context,...proposal,requireQuorum:false});
  const confirmation=await digest(provider,'adult-removal-set-review-v1',{eventHash:checked.eventHash,grantHash:checked.grantHash});
  const excluded=context.parent.devices.filter(d=>d.active&&removedDevice(proposal.item.event,d));
  const voters=proposal.item.approvals.map(({adultId,deviceId})=>({adultId,deviceId}));
  return {eventHash:checked.eventHash,grantHash:checked.grantHash,confirmation,parentHead:context.parent.head,sourceRevision:context.record.revision,
   approvals:checked.approvals,required:checked.required,complete:checked.complete,
   canApprove:!voters.some(v=>v.adultId===adultId),approved:voters,
   excludedAdultId:proposal.item.event.subject.adultId,excludedDevices:excluded.map(d=>d.deviceId),
   recipients:proposal.grant.recipients.slice()};
 }
 async function proposalContext(proposal,context,publisherRecord,publisherParent) {
  if(publisherParent!==undefined){
   if(publisherRecord!==undefined||!validatePairingAuthority(publisherParent).ok||!same(publisherParent.scope,capturedScope))throw Error('INVALID_PROOF');
   const view={readPairingAuthority:async()=>({ok:true,value:publisherParent})};
   const publisher=await verifyPublicParent(view,capturedScope,pin,provider),publisherNode=publisher.nodes.get(publisher.state.activeHead);
   if(publisher.state.activeHead!==context.state.activeHead||!same(publisherNode,context.parent))throw Error('INVALID_PARENT');
   return {...publisher,parent:publisherNode,record:context.record,local:context.local};
  }
  if(publisherRecord!==undefined){
   if(!validatePairingAuthority(publisherRecord).ok||!same(publisherRecord.scope,capturedScope)||publisherRecord.revision<1)throw Error('INVALID_PROOF');
   let state;try{state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(publisherRecord.authorityState));}catch{throw Error('INVALID_PROOF');}
   if(!same(publisherRecord.authorityState,authorityBytes(state))||!Array.isArray(state.events)||!state.events.length||!Array.isArray(state.selections)||!state.selections.length||state.activeHead!==publisherRecord.acceptedParent||state.activeHead!==proposal?.grant?.eventHash||await snapshotId(provider,state)!==publisherRecord.authorizationSnapshot)throw Error('INVALID_PROOF');
   const prior=structuredClone(state);prior.events.pop();prior.selections.pop();prior.activeHead=proposal.manifest.parentHead;
   const record={scope:capturedScope,revision:publisherRecord.revision-1,acceptedParent:proposal.manifest.parentHead,
    authorizationSnapshot:proposal.manifest.authorizationSnapshot,authorityState:authorityBytes(prior)};
   const view={readPairingAuthority:async()=>({ok:true,value:record})};
   const publisher=await verifyPublicParent(view,capturedScope,pin,provider),publisherParent=publisher.nodes.get(publisher.state.activeHead);
   if(publisher.state.activeHead!==context.state.activeHead||!same(publisherParent,context.parent))throw Error('INVALID_PARENT');
   return {...publisher,parent:publisherParent,record:context.record,local:context.local};
  }
  return context;
 }
 async function review({proposal,publisherRecord,publisherParent}) {
  ({proposal,publisherRecord,publisherParent}=structuredClone({proposal,publisherRecord,publisherParent}));
  const context=await parent(),checkedContext=await proposalContext(proposal,context,publisherRecord,publisherParent);
  const result=await inspect(proposal,checkedContext);await unchanged(context.record);return result;
 }
 async function reviewFile({release}) {
  release=structuredClone(release);
  const {proposal,publisherRecord}=release;
  const local=await parent(),context=await proposalContext(proposal,local,publisherRecord,undefined);
  const checked=await inspect(proposal,context);
  await verifyAdultRemovalFileAddress({scope:capturedScope,provider,sodium,parent:context.parent,release,recipientDeviceId:deviceId});
  await unchanged(local.record);
  return checked;
 }
 async function prepare({targetAdultId,bindings,explicit}) {
  if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');
  const context=await parent();
  const legacy=await revocation.prepare({targetAdultId,bindings,explicit});
  const item=legacy.proposal.item,used=new Set([...Object.values(context.parent.runtime.authorPeers),...item.event.subject.devices.map(d=>d.peerId)]);
  const allocateSeed=()=>{
   for(let i=0;i<32;i++){
    const bytes=sodium.randombytes_buf(8),peerId=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getBigUint64(0).toString();
    if(peerId!=='0'&&!used.has(peerId)){used.add(peerId);return {seedId:randomUUID(),peerId};}
   }
   throw Error('PEER_GENERATION_FAILED');
  };
  const projected=await prepareAdultRemovalDocumentSet({runtime,service,item,allocateSeed});
  const subject=item.event.subject,grant={version:3,householdId:capturedScope.id,parentHead:context.parent.head,eventHash:projected.eventHash,
   newEpochId:subject.newEpochId,newGeneration:subject.newGeneration,documentId:subject.documentId,manifestHash:projected.manifestHash,
   recipients:subject.devices.map(d=>d.deviceId),packageRefs:subject.devices.map(()=>randomUUID()),
   contentClasses:['pantry','recipe','shopping'],disclosure:'current-state-only',signatures:[]};
  const proposal={item,grant,manifest:projected.manifest,recipientBindings:legacy.proposal.recipientBindings};
  const result=await inspect(proposal,context);await unchanged(context.record);
  return {proposal,publisherParent:context.record,...result};
 }
 async function approve({proposal,publisherParent,confirmed,explicit}) {
  if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');
  ({proposal,publisherParent}=structuredClone({proposal,publisherParent}));const context=await parent(),checkedContext=await proposalContext(proposal,context,undefined,publisherParent),checked=await inspect(proposal,checkedContext);
  if(confirmed!==checked.confirmation)throw Error('REVIEW_CHANGED');
  if(!checked.canApprove)throw Error('ALREADY_APPROVED');
  const event=proposal.item.event,voter={adultId,deviceId};
  const approval={version:1,householdId:capturedScope.id,eventHash:checked.eventHash,parentHead:event.parentHead,
   policyHash:event.policyHash,generation:event.generation,epochId:event.epochId,...voter};
  const signature=hex(await provider.sign(signingKey,domain('approval-signature',approval)));
  const grantSignature=hex(await provider.sign(signingKey,domain('adult-removal-set-grant-vote-v3',{grant:grantBody(proposal.grant),...voter})));
  proposal.item.approvals.push({...approval,signature});proposal.grant.signatures.push({...voter,signature:grantSignature});
  const result=await inspect(proposal,checkedContext);await unchanged(context.record);
  return {proposal,...result};
 }
 const sponsorOptions=operationId=>({storage,scope:capturedScope,operationId,pin,provider,sodium,LoroDoc,keys,deviceId});
 async function status() {
  const mounted=runtime.authority?.adultRemoval;
  if(mounted){
   if(runtime.storage!==storage||runtime.scope.scopeId!==capturedScope.id||runtime.scope.authorDevice!==deviceId||mounted.options.role!=='sponsor')throw Error('UNSUPPORTED_VERSION');
   await runtime.authorize();
   const checked=await reopenAdultRemovalSponsor(sponsorOptions(mounted.options.operationId));
   return {scope:capturedScope,head:checked.record.acceptedParent,role:'sponsor',operationId:mounted.options.operationId,
    roster:checked.child.roster,recipients:checked.child.runtime.acceptedRecipients.filter(id=>id!==deviceId)};
  }
  const context=await parent(),roster=context.parent.roster.slice();
  const targets=roster.filter(id=>id!==adultId).map(id=>({adultId:id,devices:context.parent.devices.filter(d=>d.active&&d.adultId===id).map(d=>d.deviceId)}));
  await unchanged(context.record);
  return {scope:capturedScope,head:context.parent.head,sourceRevision:context.record.revision,roster,targets};
 }
 async function binding() {
  const context=await parent(),result=await revocation.binding();await unchanged(context.record);return result;
 }
 async function hashes(proposal) {
  if(!exact(proposal,'item,grant,manifest,recipientBindings'))throw Error('INVALID_PROPOSAL');
  const eventHash=await digest(provider,'event',proposal.item.event);
  const grantHash=await digest(provider,'adult-removal-set-distribution-grant-v3',grantBody(proposal.grant));
  const confirmation=await digest(provider,'adult-removal-set-review-v1',{eventHash,grantHash});
  return {eventHash,grantHash,confirmation};
 }
 async function retained(proposal) {
  const operationId=proposal.item.event.proposalId,result=await storage.readAdultRemovalPublication(capturedScope.id,operationId);
  if(!result.ok)throw Error('INVALID_RECEIPT');
  if(!result.value)return null;
  const verified=await reopenAdultRemovalSponsor({...sponsorOptions(operationId),expectedProposal:proposal});
  return {operationId,head:verified.record.acceptedParent};
 }
 async function publish({proposal,confirmed,explicit}) {
  if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');
  proposal=structuredClone(proposal);mutableContext();const h=await hashes(proposal);
  if(confirmed!==h.confirmation||runtime.scope.branchHead!==proposal.item.event.parentHead)throw Error('REVIEW_CHANGED');
  const prior=await retained(proposal);if(prior)return prior;
  const checked=await review({proposal});
  if(checked.confirmation!==confirmed || !checked.complete || proposal.item.event.authorDeviceId!==deviceId)throw Error('REVIEW_CHANGED');
  try {
   return await publishAdultRemovalDocumentSet({runtime,service,sodium,keys,signingKey,
    withSigningSecret:fn=>withSecrets(({signingSecret})=>fn(signingSecret)),proposal,
    confirmation:{explicit:true,eventHash:checked.eventHash,grantHash:checked.grantHash}});
  } catch(error) {const recovered=await retained(proposal);if(recovered)return recovered;throw error;}
 }
 async function exportFile({operationId,recipientDeviceId}) {
  const mounted=runtime.authority?.adultRemoval;
  if(mounted){
   if(runtime.storage!==storage||runtime.scope.scopeId!==capturedScope.id||runtime.scope.authorDevice!==deviceId||mounted.options.role!=='sponsor'||mounted.options.operationId!==operationId)throw Error('INVALID_RECIPIENT');
   await runtime.authorize();
  }else mutableContext();
  await reopenAdultRemovalSponsor(sponsorOptions(operationId));
  const release=await releaseAdultRemoval({...sponsorOptions(operationId),recipientDeviceId});
  if(!mounted && runtime.scope.branchHead!==release.proposal.item.event.parentHead)throw Error('STALE_AUTHORITY');
  return release;
 }
 async function install({release,confirmed,sourceRevision,explicit}) {
  if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');
  release=structuredClone(release);const proposal=release.proposal,h=await hashes(proposal);
  if(confirmed!==h.confirmation||!Number.isSafeInteger(sourceRevision)||sourceRevision<0)throw Error('REVIEW_CHANGED');
  mutableContext();
  if(runtime.scope.branchHead!==proposal.item.event.parentHead)throw Error('STALE_AUTHORITY');
  const existing=await storage.readAdultRemovalRecipient(capturedScope.id,proposal.item.event.proposalId);
  if(!existing.ok)throw Error('INVALID_RECEIPT');
  if(!existing.value){const checked=await review({proposal,publisherRecord:release.publisherRecord});if(checked.confirmation!==confirmed||checked.sourceRevision!==sourceRevision||!checked.complete)throw Error('REVIEW_CHANGED');}
  return withSecrets(({signingSecret,wrappingSecret})=>installAdultRemovalRelease({storage,scope:capturedScope,pin,provider,sodium,LoroDoc,keys,release,
   recipientDeviceId:deviceId,wrappingSecret,signSelection:bytes=>sodium.crypto_sign_detached(bytes,signingSecret),
   confirmedHead:h.eventHash,confirmedGrantHash:h.grantHash,expectedRevision:sourceRevision}));
 }
 return {prepare,review,reviewFile,approve,status,binding,publish,exportFile,install};
}
