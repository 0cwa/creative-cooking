import {authorityBytes} from '../authority/chain.mjs';
import {domain,removedDevice} from '../authority/validator.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {prepareAdultRemovalDocumentSet} from '../projection/current-document-set.mjs';
import {verifyAdultRemovalGrant} from '../compromise/adult-removal-grant.mjs';
import {digest,exact,grantBody,hex} from '../compromise/revocation.mjs';

const same=(a,b)=>hex(authorityBytes(a))===hex(authorityBytes(b));

/** Public proposal and votes only; projection snapshots never leave preparation. */
export function householdAdultRemoval({storage,scope,pin,provider,sodium,runtime,service,deviceId,adultId,signingKey,randomUUID,revocation}) {
 const capturedScope=structuredClone(scope);
 async function parent() {
  const authority=runtime.authority;
  if(!authority||authority.rootPin!==pin||authority.provider!==provider||authority.activatedPolicy||authority.returnedPolicy||authority.adultRemoval||authority.installedSet?.paired || runtime.scope.scopeId!==capturedScope.id || runtime.scope.authorDevice!==deviceId)throw Error('UNSUPPORTED_VERSION');
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
  return {eventHash:checked.eventHash,grantHash:checked.grantHash,confirmation,parentHead:context.parent.head,
   approvals:checked.approvals,required:checked.required,complete:checked.complete,
   canApprove:!voters.some(v=>v.adultId===adultId),approved:voters,
   excludedAdultId:proposal.item.event.subject.adultId,excludedDevices:excluded.map(d=>d.deviceId),
   recipients:proposal.grant.recipients.slice()};
 }
 async function review({proposal}) {
  proposal=structuredClone(proposal);const context=await parent();
  const result=await inspect(proposal,context);await unchanged(context.record);return result;
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
  return {proposal,...result};
 }
 async function approve({proposal,confirmed,explicit}) {
  if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');
  proposal=structuredClone(proposal);const context=await parent(),checked=await inspect(proposal,context);
  if(confirmed!==checked.confirmation)throw Error('REVIEW_CHANGED');
  if(!checked.canApprove)throw Error('ALREADY_APPROVED');
  const event=proposal.item.event,voter={adultId,deviceId};
  const approval={version:1,householdId:capturedScope.id,eventHash:checked.eventHash,parentHead:event.parentHead,
   policyHash:event.policyHash,generation:event.generation,epochId:event.epochId,...voter};
  const signature=hex(await provider.sign(signingKey,domain('approval-signature',approval)));
  const grantSignature=hex(await provider.sign(signingKey,domain('adult-removal-set-grant-vote-v3',{grant:grantBody(proposal.grant),...voter})));
  proposal.item.approvals.push({...approval,signature});proposal.grant.signatures.push({...voter,signature:grantSignature});
  const result=await inspect(proposal,context);await unchanged(context.record);
  return {proposal,...result};
 }
 return {prepare,review,approve};
}
