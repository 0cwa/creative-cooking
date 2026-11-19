import {authorityBytes,decodeEvidence,snapshotId,verifyAuthority} from '../authority/chain.mjs';
import {verifyOwnDeviceEvent} from '../authority/own-device.mjs';
import {domain} from '../authority/validator.mjs';
import {policyBaseline,verifyPolicyBaseline} from '../authority/policy-baseline.mjs';
import {validate} from '../domain/registry.mjs';
import {assertCommandScope} from '../domain/personal-codec.mjs';
import {disclosureService} from '../disclosure/service.mjs';
import {pairingDigest} from './personal-copy.mjs';
import {verifyStoredKeyPackage} from './key-package.mjs';

export const HOUSEHOLD_OWN_DEVICE_FILE = 'household-own-device-file';
const decoder = new TextDecoder('utf-8',{fatal:true});
export const must = result => {
 if(!result.ok)throw Error(result.error?.code??result.error);
 return result.value;
};
export const exact=(value,fields)=>!!value&&typeof value==='object'&&Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
export const sameOwnDevice = (sodium,a,b) => sodium.to_hex(authorityBytes(a))===sodium.to_hex(authorityBytes(b));
const ident=value=>typeof value==='string'&&value.length>0&&new TextEncoder().encode(value).length<=256;
const digest=(sodium,bytes)=>pairingDigest(sodium,bytes);
const cookingRoots=new Set(['recipe','recipe-index','pantry-index','shopping-cycles','shopping-item-versions',
 'purchases','purchase-corrections','domain-effects']);
const cookingMap=/^(?:recipe|recipe-intentions|recipe-ingredient|recipe-ingredient-index|recipe-step|recipe-step-index|pantry|shopping-list|shopping-item|shopping-item-fields|field-head):.+$/;
const cookingContainer=name=>cookingRoots.has(name)||cookingMap.test(name);
const cookingOperation=op=>typeof op.container==='string'&&op.container.startsWith('cid:root-')&&
 op.container.endsWith(':Map')&&cookingContainer(op.container.slice(9,-4));

export function inspectOwnDeviceSnapshot({LoroDoc,snapshot,peerId,seed,seedSnapshot}) {
 if(!(snapshot instanceof Uint8Array)||!snapshot.length||snapshot.length>1_048_576)throw Error('INVALID_SOURCE');
 const doc=new LoroDoc();
 if(doc.import(snapshot).pending?.size||doc.oplogVersion().toJSON().has(peerId)||
    Object.keys(doc.toJSON()).some(name=>!cookingContainer(name))||
    doc.exportJsonUpdates(undefined,undefined,false).changes.some(change=>change.ops.some(op=>!cookingOperation(op))))throw Error('INVALID_SOURCE');
 const markers=Object.entries(doc.getMap('domain-effects').toJSON()).sort(([a],[b])=>a<b?-1:a>b?1:0);
 if(markers.length>4096||!exact(seed,['seedId','identities'])||!ident(seed.seedId)||!Array.isArray(seed.identities))throw Error('INVALID_SOURCE');
 const seeded=[];
 const identities=markers.map(([effectId,marker])=>{
  if(!ident(effectId))throw Error('INVALID_SOURCE');
  if(marker?.version===3){
   if(marker.seedId!==seed.seedId||marker.effectId!==effectId||!ident(marker.commandId))throw Error('INVALID_SOURCE');
   const identity={effectId,commandId:marker.commandId};seeded.push(identity);return identity;
  }
  const command=validate(marker?.command);
  assertCommandScope(command.kind,'household');
  if(marker?.version!==2||command.effectId!==effectId||['chef-proposal-create','chef-accept'].includes(command.kind))throw Error('INVALID_SOURCE');
  return {effectId,commandId:command.commandId};
 });
 if(new Set(identities.map(row=>row.commandId)).size!==identities.length||
    JSON.stringify(seeded)!==JSON.stringify(seed.identities.map(({effectId,commandId})=>({effectId,commandId})).sort((a,b)=>a.effectId<b.effectId?-1:a.effectId>b.effectId?1:0))||
    (seedSnapshot===null?seeded.length!==0:!(seedSnapshot instanceof Uint8Array)||seedSnapshot.length>1_048_576))throw Error('INVALID_SOURCE');
 return {doc,identities};
}

export const ownDeviceSourcesHash = (sodium,sources) => digest(sodium,domain('household-own-device-sources',sources));
export function ownDeviceCopyHash(sodium,{snapshot,seed,seedSnapshot,sources,policies}) {
 return digest(sodium,domain('household-own-device-copy',{
  snapshot:digest(sodium,snapshot),seed,seedSnapshot:seedSnapshot===null?null:digest(sodium,seedSnapshot),sources,policies
 }));
}

export async function verifyOwnDeviceDocumentCopy({sodium,provider,LoroDoc,copy,pin,parentState,authorDevice,householdId,peerId,baseline}) {
 const {snapshot,seed,seedSnapshot,sources,policies}=copy;
 const {doc,identities}=inspectOwnDeviceSnapshot({LoroDoc,snapshot,peerId,seed,seedSnapshot});
 if(!Array.isArray(sources)||sources.length!==identities.length||!Array.isArray(policies)||policies.length>64||
    sources.some((row,i)=>!exact(row,['effectId','policyHashes'])||row.effectId!==identities[i].effectId||
     !Array.isArray(row.policyHashes)||row.policyHashes.length>64||row.policyHashes.some((hash,j)=>
      !/^[0-9a-f]{64}$/.test(hash)||(j>0&&row.policyHashes[j-1]>=hash)))||
    !sameOwnDevice(sodium,await policyBaseline(doc,provider),baseline))throw Error('INVALID_COPY');
 if(seedSnapshot!==null){
  const retained=new LoroDoc();
  if(retained.import(seedSnapshot).pending?.size)throw Error('INVALID_SEED');
  const baseline=await policyBaseline(retained,provider);
  await verifyPolicyBaseline(doc,LoroDoc,baseline,provider);
 }
 const records=new Map();
 for(const record of policies){
  if(!exact(record,['policyHash','policy','approvals'])||!/^[0-9a-f]{64}$/.test(record.policyHash)||records.has(record.policyHash))throw Error('INVALID_POLICY');
  records.set(record.policyHash,record);
 }
 const scope={kind:'household',id:householdId};
 const policyStorage={readDisclosurePolicy:async(_scope,id)=>({ok:true,value:records.get(id)??null})};
 const service=disclosureService({storage:policyStorage,scope,rootPin:pin,provider,deviceId:authorDevice});
 const context={current:{state:parentState,activeHead:parentState.activeHead},verified:await verifyAuthority(parentState,pin,provider)};
 for(const hash of new Set(sources.flatMap(row=>row.policyHashes)))await service.validateStored(hash,context);
 return identities;
}

export async function verifyOwnDeviceCopy({sodium,provider,LoroDoc,copy,pin,parentState,item}) {
 const {subject,authorDeviceId:authorDevice,householdId}=item.event;
 const identities=await verifyOwnDeviceDocumentCopy({sodium,provider,LoroDoc,copy,pin,parentState,
  authorDevice,householdId,peerId:subject.peerId,baseline:subject.baseline});
 if(ownDeviceCopyHash(sodium,copy)!==subject.copyHash||
    ownDeviceSourcesHash(sodium,copy.sources)!==subject.sourcesHash)throw Error('INVALID_COPY');
 return identities;
}

export function ownDevicePacketContext(item,oob,head) {
 const event=item.event, s=event.subject;
 return {version:1,transcriptHash:oob.hash,releaseId:event.proposalId,scopeKind:'household',scopeId:event.householdId,
  purpose:'data',epochId:event.epochId,generation:event.generation,senderDevice:event.authorDeviceId,
  senderSigningKey:oob.pins.initiator.signingKey,senderWrappingKey:oob.pins.initiator.wrappingKey,
  recipientDevice:s.deviceId,recipientSigningKey:s.signingKeyRef,recipientWrappingKey:s.wrappingKeyRef,
  policyHash:event.policyHash,grantHash:head,projectionId:s.documentId,manifestHash:s.copyHash};
}

export async function verifyOwnDeviceSuccessor({sodium,provider,pin,parentRecord,next,proposal}) {
 const state=JSON.parse(decoder.decode(parentRecord.authorityState)), child=JSON.parse(decoder.decode(next.authorityState));
 const item=child.events.at(-1), selection=child.selections.at(-1), head=next.acceptedParent;
 if(!item?.ownDevice||item.event.kind!=='pairOwnDevice'||item.event.version!==4||
    item.event.subject.parentSnapshot!==parentRecord.authorizationSnapshot||item.event.parentHead!==parentRecord.acceptedParent||
    sodium.to_hex(await provider.hash(domain('event',item.event)))!==head||
    state.activeHead!==parentRecord.acceptedParent||selection?.from!==state.activeHead||selection.to!==head||
    selection.deviceId!==item.event.authorDeviceId||!sameOwnDevice(sodium,next.scope,parentRecord.scope)||
    !sameOwnDevice(sodium,child,{...state,events:[...state.events,item],selections:[...state.selections,selection],activeHead:head})||
    sodium.to_hex(next.authorityState)!==sodium.to_hex(authorityBytes(child))||
    await snapshotId(provider,child)!==next.authorizationSnapshot)throw Error('INVALID_AUTHORITY');
 const verified=await verifyAuthority(child,pin,provider);
 const parent=verified.nodes.get(state.activeHead), proof=decodeEvidence(item.ownDevice);
 const oob=verifyOwnDeviceEvent(sodium,pin,parent,item.event,proof,verified.wrappingByHead.get(parent.head).get(item.event.authorDeviceId));
 if(proposal&&(oob.hash!==proposal.hash||proof.guard.guardId!==proposal.guard.guardId))throw Error('INVALID_OWN_DEVICE');
 const context=ownDevicePacketContext(item,oob,head);
 return {state,item,proof,context,head,selection};
}

export function ownDeviceReceiptBody(sodium,p,context) {
 return {version:1,scopeId:p.scopeId,operationId:p.operationId,keyOperationId:p.localKey.record.operationId,
  guardId:p.guardId,recipientDevice:context.recipientDevice,parentHead:p.expectedAuthority.acceptedParent,
  acceptedHead:p.nextAuthority.acceptedParent,documentId:p.documentId,epochId:context.epochId,copyHash:context.manifestHash,
  packetHash:digest(sodium,p.packet),fileHash:p.ownDevice.fileHash};
}

export async function verifyInstalledOwnDevice({sodium,provider,pin,LoroDoc,p}) {
 const {state,item,proof,context}=await verifyOwnDeviceSuccessor({sodium,provider,pin,parentRecord:p.expectedAuthority,next:p.nextAuthority});
 const {seedSnapshot,sources,policies}=p.ownDevice;
 const identities=await verifyOwnDeviceCopy({sodium,provider,LoroDoc,pin,parentState:state,item,copy:{snapshot:p.snapshot,seed:p.seed,seedSnapshot,sources,policies}});
 const local=p.localKey.record.identity, body=ownDeviceReceiptBody(sodium,p,context);
 if(!sameOwnDevice(sodium,identities,p.ownDevice.identities)||p.guardId!==proof.guard.guardId||p.documentId!==context.projectionId||
    p.generation!==context.generation||p.manifest.id!==context.manifestHash||
    sodium.to_hex(p.manifest.bytes)!==sodium.to_hex(authorityBytes(item.event.subject))||
    local.scope.kind!=='household'||local.scope.id!==context.scopeId||local.deviceId!==context.recipientDevice||
    local.epochId!==context.epochId||local.purpose!=='data'||p.policySeed!==null||
    !sameOwnDevice(sodium,body,p.receiptBody))throw Error('INVALID_AUTHORITY');
 verifyStoredKeyPackage(sodium,p.packet,context);
 if(!sodium.crypto_sign_verify_detached(p.receipt,domain('household-own-device-receipt',body),sodium.from_hex(context.recipientSigningKey)))throw Error('INVALID_AUTHORITY');
 return {parent:state,installation:p,transcriptHash:context.transcriptHash};
}
