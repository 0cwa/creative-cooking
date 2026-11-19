import {authorityBytes,matchesInstalledSetAuthority,snapshotId} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {verifyRetainedPolicyBaseline} from '../authority/policy-baseline.mjs';
import {verifyStagedPolicyDocumentSet} from './stage-policy-document-set.mjs';
import {policyTargetKeySlot} from './prepare-policy-document-keys.mjs';
import {selectedSourceHash} from '../projection/selected-sources.mjs';
import {inspectOwnDeviceSnapshot,verifyOwnDeviceDocumentCopy,exact} from '../pairing/household-own-device.mjs';
import {MAX_SELECTED_SET_BYTES} from '../contracts/runtime-storage.ts';
import defaultSodium from 'libsodium-wrappers';

const canon=x=>x instanceof Uint8Array?Array.from(x):Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
const same=(a,b)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));

/** Verify a past activation without asserting that it is currently selected. */
export async function readHistoricalPolicyActivationEvidence(args) {
 const proof=await verifyActivationEvidence(args, false);
 return structuredClone({targetHead:proof.targetHead,sourceHead:proof.sourceHead,expected:proof.expected,next:proof.record,
  mapping:proof.mapping,
  documents:proof.documents.map(({recipeId,documentId,revision,targetDocumentId,operationId,identity})=>
   ({recipeId,documentId,revision,targetDocumentId,operationId,identity}))});
}

/** Authenticate an activation only while its exact authority is selected. */
export async function readVerifiedActivatedPolicyDocumentSet(args) {
 return verifyActivationEvidence(args, true);
}

export async function readPolicyReturnActivationEvidence(args) {
 return verifyActivationEvidence(args,true,true);
}

async function verifyActivationEvidence({storage,LoroDoc,pin,provider,scope,deviceId,targetHead,keys,sodium=defaultSodium}, selected, detached=false) {
 scope=structuredClone(scope);
 if(scope?.kind!=='household' || typeof deviceId!=='string') throw Error('INVALID_AUTHORITY');
 const loaded=await storage.readActivatedPolicyDocumentSet(scope.id,targetHead,!selected);
 if(!loaded.ok) throw Error(loaded.error.code);
 if(!loaded.value) throw Error('ACTIVATION_NOT_FOUND');
 const {receipt,staged,documents}=structuredClone(loaded.value);
 if(!receipt || !same(receipt.expected?.scope,scope) || !same(receipt.next?.scope,scope)) throw Error('INVALID_AUTHORITY');
 if(selected) {
  const current=await storage.readPairingAuthority(scope);
  if(!current.ok || !same(current.value,receipt.next)) throw Error('INVALID_AUTHORITY');
 }
 const view={readPairingAuthority:async requested=>same(requested,scope)?{ok:true,value:structuredClone(receipt.expected)}:{ok:false,error:'INVALID_AUTHORITY'}};
 let envelope;
 try {envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(staged.proof));} catch {throw Error('INVALID_STAGED_PROOF');}
 const manifest=envelope?.[2]?.signed?.body?.observation?.manifest;
 if(!manifest?.root) throw Error('INVALID_STAGED_PROOF');
 const route={scopeId:scope.id,branchHead:manifest.parentHead,documentId:manifest.root.documentId,epochId:manifest.epochId,documentGeneration:manifest.generation,authorDevice:deviceId};
 const proof=await verifyStagedPolicyDocumentSet({storage:view,LoroDoc,pin,provider,stage:staged,scope:route,targetHead});
 let parent,next;
 try {parent=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(receipt.expected.authorityState));next=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(receipt.next.authorityState));}catch{throw Error('INVALID_AUTHORITY');}
 const selection=next.selections?.at(-1), signer=proof.parent.devices.find(d=>d.active&&d.deviceId===deviceId);
 const extension=structuredClone(parent);
 extension.events.push(proof.item); extension.selections.push(selection); extension.activeHead=targetHead;
 const expectedNext={...receipt.expected,revision:receipt.expected.revision+1,acceptedParent:targetHead,authorizationSnapshot:await snapshotId(provider,extension),authorityState:authorityBytes(extension)};
 if(!same(receipt.next,expectedNext) || !same(next,extension) || !selection ||
   Object.keys(selection).sort().join(',')!=='deviceId,from,index,signature,to' ||
   selection.from!==parent.activeHead || selection.to!==targetHead || selection.deviceId!==deviceId ||
   selection.index!==parent.selections.length || !signer || typeof selection.signature!=='string' || !/^[a-f0-9]{128}$/.test(selection.signature)) throw Error('INVALID_SELECTION');
 const {signature,...body}=selection;
 if(!await provider.verify(signer.signingKeyRef,domain('select-head',{root:pin,householdId:scope.id,...body}),Uint8Array.from(signature.match(/../g),x=>parseInt(x,16)))) throw Error('INVALID_SELECTION');
 // Only the admission selected at the authenticated source head can supply
 // inherited seeds. Its receipt verifies the original snapshots independently.
 const admission=parent.events.find(event=>event.admission?.manifest?.version===5 &&
  event.admission.grant?.admissionEventHash===receipt.expected.acceptedParent);
 let sourceSeeds=new Map();
 if(admission){
  const {readInstalledHouseholdDocumentSet}=await import('../pairing/household-document-set.mjs');
  const installed=await readInstalledHouseholdDocumentSet({storage,LoroDoc,pin,scope,provider,operationId:admission.admission.operationId,sodium});
  if(!matchesInstalledSetAuthority(receipt.expected,parent,installed.publication.nextAuthority) ||
   !same(admission,installed.item) || installed.selection.to!==receipt.expected.acceptedParent ||
   installed.publication.localKey.record.identity.deviceId!==deviceId) throw Error('INVALID_AUTHORITY');
  const entries=installed.item.admission.manifest.entries;
  sourceSeeds=new Map(installed.documents.map((document,i)=>[document.documentId,{recipeId:entries[i].recipeId??null,
   seed:{snapshot:document.seed.snapshot,seed:{seedId:document.seed.seedId,identities:document.seed.identities}}}]));
 }
 // A legacy recipient retains its original signed admission snapshot outside
 // the v5 document-set format. Only the admission at the authenticated source
 // head may supply that seed; an unrelated historical receipt is insufficient.
 if(!admission && storage.householdRecipient?.findByEvent){
  const found=await storage.householdRecipient.findByEvent(scope.id,receipt.expected.acceptedParent);
  if(!found.ok)throw Error('INVALID_AUTHORITY');
  if(found.value){
   const original=found.value, checked=await storage.householdRecipient.check(original);
   if(!checked.ok || checked.value!==true || original.scopeId!==scope.id ||
      original.receiptBody?.recipientDevice!==deviceId || original.nextAuthority.acceptedParent!==receipt.expected.acceptedParent ||
      original.documentId!==manifest.root.documentId)throw Error('INVALID_AUTHORITY');
   sourceSeeds.set(original.documentId,{recipeId:null,seed:{snapshot:original.snapshot,seed:original.seed}});
  }
 }
 if(!Array.isArray(documents) || !Array.isArray(receipt.targets) || documents.length!==staged.mapping.length || receipt.targets.length!==staged.mapping.length) throw Error('INVALID_ACTIVATION');
 for(let i=0;i<documents.length;i++) {
  const row=staged.mapping[i],doc=documents[i],slot=await policyTargetKeySlot({scope:route,pin,provider,targetHead,row});
  if(doc.documentId!==row.targetDocumentId || !same(receipt.targets[i],{targetDocumentId:row.targetDocumentId,operationId:slot.operationId,identity:slot.identity})) throw Error('INVALID_ACTIVATION');
  await verifyRetainedPolicyBaseline(LoroDoc,doc,proof.signed.body.documents[i].baseline,provider);
  await keys.use(slot.operationId,slot.identity,()=>{});
 }
 let provenance=null;
 if(receipt.provenance!==undefined && receipt.provenance!==null) {
  const attestation=receipt.provenance, bytes=attestation?.statement;
  if(!exact(attestation,['statement','signature']) || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length>MAX_SELECTED_SET_BYTES ||
    typeof attestation.signature!=='string' || !/^[a-f0-9]{128}$/.test(attestation.signature)) throw Error('INVALID_PROVENANCE');
  let envelope;
  try {envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));} catch {throw Error('INVALID_PROVENANCE');}
  const body=envelope?.[2];
  if(!Array.isArray(envelope) || envelope.length!==3 || !exact(body,['version','scope','pin','deviceId','sourceHead','targetHead','sourceSnapshot','nextSnapshot','guardHash','stageProofHash','rows']) ||
    !same(bytes,domain('policy-provenance-receipt-v1',body)) || body.version!==1 || !same(body.scope,scope) || body.pin!==pin || body.deviceId!==deviceId ||
    body.sourceHead!==receipt.expected.acceptedParent || body.targetHead!==targetHead || body.sourceSnapshot!==receipt.expected.authorizationSnapshot ||
    body.nextSnapshot!==receipt.next.authorizationSnapshot || !/^[a-f0-9]{64}$/.test(body.guardHash) ||
    body.stageProofHash!==await selectedSourceHash(provider,'policy-provenance-stage-proof-v1',staged.proof) ||
    !Array.isArray(body.rows) || body.rows.length!==staged.mapping.length ||
    !await provider.verify(signer.signingKeyRef,bytes,Uint8Array.from(attestation.signature.match(/../g),x=>parseInt(x,16)))) throw Error('INVALID_PROVENANCE');
  const effects=new Set(), commands=new Set();
  for(const [i,row] of body.rows.entries()) {
   const mapping=staged.mapping[i], inherited=sourceSeeds.get(mapping.sourceDocumentId);
   if(!exact(row,['recipeId','sourceDocumentId','targetDocumentId','baseline','identities','sources','policies']) ||
     row.recipeId!==mapping.recipeId || row.sourceDocumentId!==mapping.sourceDocumentId || row.targetDocumentId!==mapping.targetDocumentId ||
     !same(row.baseline,proof.signed.body.documents[i].baseline) || (inherited && inherited.recipeId!==mapping.recipeId) ||
     !Array.isArray(row.sources) || row.sources.some(source=>!exact(source,['effectId','policyHashes','incomplete']) || source.incomplete!==true)) throw Error('INVALID_PROVENANCE');
   const seed=inherited?.seed.seed??{seedId:'empty',identities:[]}, seedSnapshot=inherited?.seed.snapshot??null;
   const snapshot=mapping.baseline;
   const {identities}=inspectOwnDeviceSnapshot({LoroDoc,snapshot,seed,seedSnapshot});
   const checked=await verifyOwnDeviceDocumentCopy({sodium,provider,LoroDoc,copy:{snapshot,seed,seedSnapshot,
    sources:row.sources.map(({incomplete,...source})=>source),policies:row.policies},pin,parentState:parent,authorDevice:deviceId,householdId:scope.id,baseline:row.baseline});
   const records=new Map(row.policies.map(record=>[record.policyHash,record]));
   const reachable=new Set();
   for(const source of row.sources) for(const hash of source.policyHashes) for(let current=hash;current && !reachable.has(current);) {
    const record=records.get(current); if(!record) throw Error('INVALID_PROVENANCE');
    reachable.add(current); current=record.policy.predecessor;
   }
   if(reachable.size!==records.size || !same(identities,row.identities) || !same(checked,identities)) throw Error('INVALID_PROVENANCE');
   for(const identity of identities) {
    if(effects.has(identity.effectId)||commands.has(identity.commandId)) throw Error('INVALID_PROVENANCE');
    effects.add(identity.effectId); commands.add(identity.commandId);
   }
  }
  provenance=body.rows;
 }
 if(selected) {
  const again=await storage.readPairingAuthority(scope);
  if(!again.ok || !same(again.value,receipt.next)) throw Error('STALE_SOURCE');
 }
 return structuredClone({targetHead,sourceHead:staged.sourceHead,expected:receipt.expected,record:receipt.next,state:next,parent:proof.parent,item:proof.item,selection,
  ...(detached?{receipt,staged,targetDocuments:documents}:{}),
  mapping:staged.mapping.map(({recipeId,sourceDocumentId})=>({recipeId,sourceDocumentId})),
  provenance,verifiedProvenance:receipt.provenance??null,documents:documents.map(({documentId,revision},i)=>{const row=staged.mapping[i],source=sourceSeeds.get(row.sourceDocumentId);
   if(source && source.recipeId!==row.recipeId)throw Error('INVALID_AUTHORITY');
   return {recipeId:row.recipeId,documentId,revision,...receipt.targets[i],policySeed:source?.seed??null};})});
}
