import {readAuthority,verifyAuthority} from '../authority/chain.mjs';
import {checkAdmissionAgreement,checkGrantSignatures,checkGrantManifest} from '../authority/grant.mjs';
import {domain,validateSuccessor} from '../authority/validator.mjs';
import {preparePolicyProjection,verifyPolicyProjection,verifySourcePolicyProjection} from '../disclosure/policy-seed.mjs';
import {prepareCurrentDocumentSet,verifyCurrentDocumentSet,verifyCurrentDocumentSetSource} from '../projection/current-document-set.mjs';

const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const hash=async(provider,purpose,value)=>{const b=await provider.hash(domain(purpose,value));if(!(b instanceof Uint8Array)||b.length!==32)throw Error('INVALID_PROOF');return hex(b)};
function allocatePeer(sodium,used){
 let peer;
 do{
  const bytes=sodium.randombytes_buf(8);
  peer=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getBigUint64(0).toString();
 }while(peer==='0'||used.has(peer));
 return peer;
}

async function signedGrant({provider,scope,parent,eventHash,subject,delegation,manifestHash,packageId,author,adultId,deviceId}){
 const devices=subject.devices;
 if(devices.length!==1)throw Error('UNSUPPORTED_RECIPIENT_SET');
 const unsigned={version:1,householdId:scope.id,parentHead:parent.head,admissionEventHash:eventHash,
  sourcePolicyHashes:[parent.policyHash],delegationHash:delegation,recipientAdult:subject.adultId,
  recipientDevices:[devices[0].deviceId],contentClasses:['pantry','recipe','shopping'],
  projectionManifestHash:manifestHash,newDocumentGeneration:subject.newGeneration,newEpochId:subject.newEpochId,
  keyEnvelopeRefs:[packageId]};
 const signature=hex(await provider.sign(author.signingKeyRef,domain('current-state-grant-signature',{grant:unsigned,adultId,deviceId})));
 return {...unsigned,signatures:[{adultId,deviceId,signature}]};
}

async function prepareDocumentSetGrant({storage,scope,pin,provider,store,sodium,runtime,service,
 adultId,deviceId,item,parent,author,delegation,eventHash,binding,restartStale,randomUUID}){
 const slot=`household-grant-draft:${parent.head}`;
 const setBinding=JSON.stringify([...JSON.parse(binding),5]);
 const subject=item.event.subject;
 const reservedPeers=[...Object.values(parent.runtime.authorPeers),...subject.devices.map(device=>device.peerId)];
 const read=tx=>{
  const draft=tx.get(slot);
  if(draft&&(draft.version!==2||draft.binding!==setBinding))throw Error('DRAFT_CONFLICT');
  const legacy=tx.get('household-grant-draft');
  if(legacy&&JSON.parse(legacy.binding)[3]===parent.head)throw Error('DRAFT_CONFLICT');
  return draft;
 };
 const fresh=()=>({version:2,binding:setBinding,packageId:randomUUID(),allocations:[]});
 let draft=await store.transaction(tx=>{
  const saved=read(tx);
  if(saved)return saved;
  if(restartStale)throw Error('NO_STALE_INVITATION');
  const next=fresh();
  tx.put(slot,next);
  return next;
 });
 const verifyGrant=async retained=>{
  if(retained.version!==2||retained.status!=='ceremony-and-source-required'||retained.grant?.keyEnvelopeRefs?.[0]!==draft.packageId||
     retained.grant?.delegationHash!==delegation)throw Error('CORRUPT_DRAFT');
  const {manifest,documents,grant}=retained;
  await verifyCurrentDocumentSet({storage,scope,pin,provider,item,grant,manifest,documents,LoroDoc:runtime.LoroDoc});
  try{await verifyCurrentDocumentSetSource({runtime,service,item,manifest,documents});}
  catch(error){if(error?.message==='SOURCE_CHANGED')throw Error('STALE_DOCUMENT_SET_DRAFT');throw error;}
 };
 if(restartStale){
  if(!draft.result)throw Error('NO_STALE_INVITATION');
  let stale=false;
  try{await verifyGrant(draft.result)}catch(error){if(error?.message!=='STALE_DOCUMENT_SET_DRAFT')throw error;stale=true;}
  if(!stale)throw Error('NO_STALE_INVITATION');
  const published=await storage.getProjectionPublication(scope.id,item.event.proposalId);
  if(!published.ok)throw Error(published.error);
  if(published.value)throw Error('INVITATION_ALREADY_PUBLISHED');
  draft=await store.transaction(tx=>{
   if(read(tx)?.packageId!==draft.packageId)throw Error('DRAFT_CONFLICT');
   const next=fresh();
   tx.put(slot,next);
   return next;
  });
 }
 const allocateSeed=documentId=>store.transaction(tx=>{
  const current=read(tx);
  if(!current||current.packageId!==draft.packageId)throw Error('DRAFT_CONFLICT');
  const retained=current.allocations.find(entry=>entry.documentId===documentId);
  if(retained)return retained;
  if(current.result)throw Error('SOURCE_CHANGED');
  const used=new Set([...reservedPeers,...current.allocations.map(entry=>entry.peerId)]);
  const next={documentId,seedId:randomUUID(),peerId:allocatePeer(sodium,used)};
  tx.put(slot,{...current,allocations:[...current.allocations,next]});
  return next;
 });
 let retained=draft.result;
 if(!retained){
  const {manifest,manifestHash,documents}=await prepareCurrentDocumentSet({runtime,service,item,allocateSeed});
  const grant=await signedGrant({provider,scope,parent,eventHash,subject,delegation,manifestHash,
   packageId:draft.packageId,author,adultId,deviceId});
  const result={version:2,grant,manifest,documents,status:'ceremony-and-source-required'};
  retained=await store.transaction(tx=>{
   const current=read(tx);
   if(!current||current.packageId!==draft.packageId)throw Error('DRAFT_CONFLICT');
   if(current.result)return current.result;
   tx.put(slot,{...current,result});
   return result;
  });
 }
 await verifyGrant(retained);
 const publisherParent=await storage.readPairingAuthority(scope);
 if(!publisherParent.ok||!publisherParent.value||publisherParent.value.authorizationSnapshot!==retained.manifest.authorizationSnapshot)throw Error('SOURCE_CHANGED');
 return structuredClone({...retained,publisherParent:publisherParent.value});
}

/** Prepare a source-bound grant. Current-cooking delegation must already be
 * explicitly accepted by every adult; the projection stays on this device. */
export async function prepareHouseholdGrant({storage,scope,pin,provider,store,sodium,runtime,service,adultId,deviceId,item,explicit,restartStale=false,randomUUID=()=>crypto.randomUUID()}){
 const sc=structuredClone(scope),proposal=structuredClone(item);if(explicit!==true||!proposal?.event||!Array.isArray(proposal.approvals))throw Error('MALFORMED');
 const authority=await readAuthority(storage,sc,pin,provider),verified=await verifyAuthority(authority.state,pin,provider),parent=verified.nodes.get(authority.activeHead),author=parent?.devices.find(d=>d.active&&d.deviceId===deviceId&&d.adultId===adultId);if(!author||proposal.event.parentHead!==authority.activeHead||proposal.event.kind!=='inviteAdult')throw Error('INVALID_AUTHORITY');
 const successor=await validateSuccessor(parent,proposal.event,proposal.authorSignature,proposal.approvals,provider);if(successor.reason!=='ADMISSION_AND_PROJECTION_REQUIRED')throw Error(successor.reason||'INVALID_PROOF');
 let delegation=null;for(const agreement of authority.state.agreements??[]){if(agreement.parentHead!==parent.head)continue;const checked=await checkAdmissionAgreement(parent,agreement,provider);if(checked.status==='accepted')delegation=checked.delegationHash}if(!delegation)throw Error('DELEGATION_REQUIRED');
 const eventHash=await hash(provider,'event',proposal.event),binding=JSON.stringify([sc.kind,sc.id,pin,parent.head,eventHash,adultId,deviceId]);
 const expectedAuthority=await runtime.authorize();
 if(expectedAuthority.record.revision!==authority.revision||expectedAuthority.record.acceptedParent!==parent.head)throw Error('SOURCE_CHANGED');
 const catalog=await storage.hasSelectedRecipeCatalog(expectedAuthority);
 if(!catalog.ok)throw Error(catalog.error.code);
 if(catalog.value)return prepareDocumentSetGrant({storage,scope:sc,pin,provider,store,sodium,runtime,service,
  adultId,deviceId,item:proposal,parent,author,delegation,eventHash,binding,restartStale,randomUUID});
 if(restartStale)throw Error('NO_STALE_INVITATION');
 const ids=await store.transaction(tx=>{const slot=`household-grant-draft:${parent.head}`,legacy=tx.get('household-grant-draft'),old=tx.get(slot);if(old){if(old.binding!==binding)throw Error('DRAFT_CONFLICT');return old}if(legacy){let prior;try{prior=JSON.parse(legacy.binding)}catch{throw Error('CORRUPT_DRAFT')}if(!Array.isArray(prior)||prior.length!==7)throw Error('CORRUPT_DRAFT');if(prior[3]===parent.head){if(legacy.binding!==binding)throw Error('DRAFT_CONFLICT');return legacy}}const used=new Set([...Object.values(parent.runtime.authorPeers),...proposal.event.subject.devices.map(d=>d.peerId)]);const peer=allocatePeer(sodium,used);const next={version:1,binding,seedId:randomUUID(),peerId:peer,packageId:randomUUID()};tx.put(slot,next);return next});
 if(ids.version!==1||ids.binding!==binding||typeof ids.seedId!=='string'||!/^[0-9a-f-]{36}$/.test(ids.seedId)||typeof ids.packageId!=='string'||!/^[0-9a-f-]{36}$/.test(ids.packageId)||typeof ids.peerId!=='string'||!/^[1-9][0-9]{0,19}$/.test(ids.peerId)||BigInt(ids.peerId)>18446744073709551615n||Object.values(parent.runtime.authorPeers).includes(ids.peerId)||proposal.event.subject.devices.some(d=>d.peerId===ids.peerId))throw Error('CORRUPT_DRAFT');
 // Publication authenticates the stored checkpoint bytes. Loro can encode the
 // same imported state differently when the in-memory document is exported.
 const checkpoint=await storage.reopenBranchDocument(expectedAuthority,parent.runtime.documentId);
 if(!checkpoint.ok||!checkpoint.value)throw Error('SOURCE_UNAVAILABLE');
 const projection=await preparePolicyProjection({runtime,service,provider,seedId:ids.seedId,peerId:ids.peerId,version:4});
 if(checkpoint.value.revision!==projection.bundle.sourceRevision)throw Error('SOURCE_CHANGED');
 const manifest={version:4,sourceDocument:parent.runtime.documentId,sourceCheckpointHash:await hash(provider,'projection-source-snapshot',hex(checkpoint.value.bytes)),sourcePolicyHashes:[parent.policyHash],projectedStateHash:await hash(provider,'projection-snapshot',hex(projection.seed.snapshot)),newDocumentId:proposal.event.subject.documentId,newGeneration:proposal.event.subject.newGeneration,schemaVersion:`registry-seed-v4|${ids.seedId}|${ids.peerId}`,sourceRevision:checkpoint.value.revision,policyBundleHash:projection.bundleHash};
 const manifestHash=await hash(provider,'projection-manifest',manifest);
 const grant=await signedGrant({provider,scope:sc,parent,eventHash,subject:proposal.event.subject,delegation,
  manifestHash,packageId:ids.packageId,author,adultId,deviceId});
 const result={version:1,grant,manifest,seed:projection.seed,policyBundle:projection.bundle,status:'ceremony-and-source-required'};
 const retained=await store.transaction(tx=>{const slot=`household-grant-draft:${parent.head}`,current=tx.get(slot)??tx.get('household-grant-draft');if(!current||current.binding!==binding)throw Error('DRAFT_CONFLICT');if(current.result)return current.result;tx.put(tx.get(slot)?slot:'household-grant-draft',{...current,result});return result});
 const signed=await checkGrantSignatures(parent,retained.grant,provider),association=await checkGrantManifest(parent,retained.grant,retained.manifest,retained.seed?.snapshot,provider),subject=proposal.event.subject;if(!retained||Object.keys(retained).sort().join(',')!=='grant,manifest,policyBundle,seed,status,version'||retained.version!==1||retained.status!=='ceremony-and-source-required'||signed.status==='deny'||association.reason!=='SOURCE_AND_PROJECTION_EVIDENCE_REQUIRED'||retained.grant.admissionEventHash!==eventHash||retained.grant.delegationHash!==delegation||retained.grant.recipientAdult!==subject.adultId||JSON.stringify(retained.grant.recipientDevices)!==JSON.stringify(subject.devices.map(d=>d.deviceId))||retained.grant.newDocumentGeneration!==subject.newGeneration||retained.grant.newEpochId!==subject.newEpochId||retained.manifest.newDocumentId!==subject.documentId)throw Error('CORRUPT_DRAFT');await verifyPolicyProjection({provider,pin,state:authority.state,seed:retained.seed,bundle:retained.policyBundle,expectedBundleHash:retained.manifest.policyBundleHash,expectedSourceHead:parent.head,expectedSourceDocument:parent.runtime.documentId,expectedSourceRevision:retained.manifest.sourceRevision,LoroDoc:runtime.LoroDoc});if(retained.manifest.sourceCheckpointHash!==manifest.sourceCheckpointHash)throw Error('SOURCE_CHANGED');await verifySourcePolicyProjection({runtime,service,provider,seed:retained.seed,bundle:retained.policyBundle,bundleHash:retained.manifest.policyBundleHash});return structuredClone(retained);
}
