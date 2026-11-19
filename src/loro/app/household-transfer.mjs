import {existingDocumentSetSignal} from '../authority/ceremony.mjs';
import {publishHouseholdAdmission,readAuthority,resolveRuntimeAuthority} from '../authority/chain.mjs';
import {selectedSourceHash} from '../projection/selected-sources.mjs';
import {publishHouseholdDocumentSet} from '../pairing/household-document-set.mjs';
import {matchesInvitationSignaling} from './household-ceremony.mjs';
import {domain} from '../authority/validator.mjs';
import {sealHouseholdFile,installHouseholdFile} from '../pairing/household-file.mjs';
import {durableSession} from '../pairing/durable-session.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {validPairingScope} from '../contracts/pairing.ts';
const enc=new TextEncoder(),hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const dec=new TextDecoder('utf-8',{fatal:true});
export function householdReceiverIds(sodium,scope,deviceId){if(!validPairingScope(scope)||scope.kind!=='household'||typeof deviceId!=='string'||!deviceId)throw Error('MALFORMED');const tag=hex(sodium.crypto_generichash(32,enc.encode(JSON.stringify([scope.id,deviceId]))));return {operationId:`receive-${tag}`,keyOperationId:`household-data-${tag}`};}
function existingDeviceIds(sodium,scope,deviceId,eventHash){
 if(typeof eventHash!=='string'||!/^[0-9a-f]{64}$/.test(eventHash))throw Error('INVALID_FILE');
 const tag=hex(sodium.crypto_generichash(32,enc.encode(JSON.stringify(['existing-household-device',scope.id,deviceId,eventHash]))));
 return {operationId:`receive-generation-${tag}`,keyOperationId:`household-data-generation-${tag}`};
}
/** Trusted app dependencies are closed over; no identity key leaves withSecrets. */
export function householdTransfer({name,sodium,storage,master,provider,sessionStore,scope,pin,deviceId,runtime,service,keys,withSecrets,LoroDoc,prepareJoinedSequences,finalizeJoinedSequences}){
 const ownScope=structuredClone(scope);
 async function completedOrganizerProof(proof,secret){
  const {transcript,guard,oob,context,messages}=proof;
  const local=await durableSession(sodium,sessionStore,secret,transcript,guard,'initiator',oob).evidence();
  const bytes=value=>hex(domain('completed-household-ceremony',value));
  if(local.hash!==oob.hash||bytes(local.messages)!==bytes(messages))throw Error('INVALID_PROOF');
  return {transcript,guard,oob,context,messages:local.messages};
 }
 async function publish(input){
  const data=structuredClone(input),event=data?.item?.event,operationId=event?.proposalId;
  const documentSet=data?.manifest?.version===5;
  if(typeof operationId!=='string'||!operationId||!Array.isArray(data.ceremonies)||!Array.isArray(data.existingCeremonies)||
     (documentSet?data.seed!==undefined||data.policyBundle!==undefined||!Array.isArray(data.documents):
      data.documents!==undefined||!(data.seed?.snapshot instanceof Uint8Array)))throw Error('MALFORMED');
  const prior=await storage.getProjectionPublication(ownScope.id,operationId);
  if(!prior.ok)throw Error(prior.error);
  if(prior.value&&!!prior.value.documentSet!==documentSet||
     runtime.authority?.installedSet&&!documentSet)throw Error('UNSUPPORTED_VERSION');
  if(documentSet){
   const {signatures,...unsigned}=data.grant??{};
   const grantHash=await selectedSourceHash(provider,'current-state-grant',unsigned);
   if(!data.ceremonies.every(proof=>matchesInvitationSignaling(proof?.transcript,proof?.context,5,grantHash))||
      !prior.value&&!data.existingCeremonies.every(proof=>Array.isArray(proof?.transcript?.signaling)&&proof.transcript.signaling.length===2&&
       hex(proof.transcript.signaling[1])===hex(existingDocumentSetSignal(grantHash))))throw Error('INVALID_PROOF');
  }
  return withSecrets(async secret=>{
   for(const proof of [...data.ceremonies,...data.existingCeremonies])await completedOrganizerProof(proof,secret);
   let selection,pendingEdits;
   if(prior.value){
    selection=JSON.parse(dec.decode(prior.value.nextAuthority.authorityState)).selections.at(-1);
    pendingEdits=prior.value.pendingEdits;
   }else{
    const current=await readAuthority(storage,ownScope,pin,provider);
    if(current.activeHead!==event.parentHead)throw Error('STALE_AUTHORITY');
    if(!documentSet){
     const expected=await runtime.authorize(),archive=await storage.listBranchLocalOperations(expected);
     if(!archive.ok)throw Error(archive.error);
     pendingEdits=archive.value;
    }
    const body={root:pin,householdId:ownScope.id,from:event.parentHead,to:data.grant.admissionEventHash,deviceId,index:current.state.selections.length};
    selection={from:body.from,to:body.to,deviceId,index:body.index,signature:hex(sodium.crypto_sign_detached(domain('select-head',body),secret.signingSecret))};
   }
   if(documentSet){
    const result=await publishHouseholdDocumentSet({storage,scope:ownScope,pin,provider,sodium,sessionStore,keys:secret,
     master,runtime,service,item:data.item,grant:data.grant,manifest:data.manifest,documents:data.documents,selection,
     localDeviceId:deviceId,ceremonies:data.ceremonies,existingCeremonies:data.existingCeremonies,keyOperationId:`admission-key:${operationId}`})
     .catch(error=>{if(error?.message==='SOURCE_CHANGED')throw Error('STALE_DOCUMENT_SET_DRAFT');throw error;});
    return {replayed:result.replayed,operationId};
   }
   const result=await publishHouseholdAdmission({storage,scope:ownScope,pin,provider,master,operationId,keyOperationId:`admission-key:${operationId}`,localDeviceId:deviceId,signingSecret:secret.signingSecret,item:data.item,grant:data.grant,manifest:data.manifest,snapshot:data.seed.snapshot,ceremonies:data.ceremonies,existingCeremonies:data.existingCeremonies,selection,pendingEdits,sourceRuntime:runtime,policyBundle:data.policyBundle,disclosureService:service});
   return {replayed:result.replayed,operationId};
  });
 }
 async function seal(input){
  const data=structuredClone(input);
  if(typeof data?.operationId!=='string'||typeof data?.recipientDevice!=='string')throw Error('MALFORMED');
  const saved=await storage.getProjectionPublication(ownScope.id,data.operationId);
  if(!saved.ok||!saved.value)throw Error('MISSING_PUBLICATION');
  const kind=saved.value.documentSet?'document-set':'admission';
  return withSecrets(keys=>sealHouseholdFile({sodium,storage,scope:ownScope,pin,provider,sessionStore,keys,
   operationId:data.operationId,recipientDevice:data.recipientDevice,LoroDoc,kind}));
 }
 async function publishedFiles(){
  const {activeHead,state}=await readAuthority(storage,ownScope,pin,provider);
  const item=state.events.find(entry=>entry.admission?.grant.admissionEventHash===activeHead&&entry.admission.localDeviceId===deviceId);
  if(!item)return null;
  const {operationId}=item.admission,result=await storage.getProjectionPublication(ownScope.id,operationId);
  if(!result.ok||!result.value)throw Error('MISSING_PUBLICATION');
  if(!!result.value.documentSet!==(item.admission.manifest.version===5))throw Error('UNSUPPORTED_VERSION');
  const recipients=[...new Set(result.value.packages.map(({recipientDevice})=>recipientDevice))];
  return {operationId,generation:item.event.subject.newGeneration,recipients:recipients.map(recipientDevice=>({recipientDevice,joining:item.admission.grant.recipientDevices.includes(recipientDevice)}))};
 }
 function checkedBytes(bytes){
  if(!(bytes instanceof Uint8Array)||bytes.length<48||bytes.length>16*1024*1024+48)throw Error('MALFORMED');
  return new Uint8Array(bytes);
 }
 async function install(input){
  const bytes=checkedBytes(input?.bytes),sc=structuredClone(input.scope),documentSet=structuredClone(input.documentSet);
  if(!validPairingScope(sc)||sc.kind!=='household')throw Error('MALFORMED');
  const confirmed=(await keys.list()).find(x=>x.scope.kind==='household'&&x.scope.id===sc.id);
  if(!confirmed)throw Error('CONFIRMATION_REQUIRED');
  const {operationId,keyOperationId}=householdReceiverIds(sodium,sc,deviceId);
  if(documentSet!==undefined&&(documentSet?.version!==5||
     ![documentSet.eventHash,documentSet.grantHash,documentSet.transcriptHash].every(value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)))){
   throw Error('MALFORMED');
  }
  const joined={name,storage,scope:sc,pin:confirmed.pin,provider,deviceId,operationId,confirmedParent:confirmed.head};
  const result=await withSecrets(secret=>installHouseholdFile({sodium,bytes,keys:secret,storage,scope:sc,pin:confirmed.pin,
   provider,sessionStore,recipientDevice:deviceId,LoroDoc,master,operationId,keyOperationId,
   recipientKind:documentSet?'document-set':'newcomer',confirmedParent:confirmed.head,
   confirmedEventHash:documentSet?.eventHash,confirmedGrantHash:documentSet?.grantHash,confirmedTranscriptHash:documentSet?.transcriptHash,
   prepareEnrollment:()=>prepareJoinedSequences(joined)}));
  const opened=await finalizeJoinedSequences(joined);opened.sequences.close();return {replayed:result.replayed,scope:sc,selected:false};
 }
 async function installExisting(input){
  const bytes=checkedBytes(input?.bytes);
  // This device already has an allocator for the active scope. A new admission
  // has its own receipt and epoch key, without enrollment or counter creation.
  const result=await withSecrets(secret=>installHouseholdFile({sodium,bytes,keys:secret,storage,scope:ownScope,pin,provider,sessionStore,recipientDevice:deviceId,LoroDoc,master,recipientKind:'existing',identify:eventHash=>existingDeviceIds(sodium,ownScope,deviceId,eventHash)}));
  if(result.head&&!result.acceptedHead){
   const current=await readAuthority(storage,ownScope,pin,provider);
   const item=current.state.events.find(entry=>entry.admission?.grant?.admissionEventHash===result.head);
   if(!item||item.admission.manifest?.version!==5)throw Error('INVALID_AUTHORITY');
   return {replayed:result.replayed,acceptedHead:result.head,generation:item.event.subject.newGeneration};
  }
  return {replayed:result.replayed,acceptedHead:result.acceptedHead,generation:result.generation};
 }
 async function readRecoveryParent(confirmed){
  const {operationId}=householdReceiverIds(sodium,confirmed.scope,deviceId);
  const prior=await storage.householdRecipient.find(confirmed.scope.id,operationId);
  if(!prior.ok)throw Error(prior.error);
  const input=prior.value?{readPairingAuthority:async()=>({ok:true,value:prior.value.expectedAuthority})}:storage;
  const verified=await verifyPublicParent(input,confirmed.scope,confirmed.pin,provider);
  if(verified.state.activeHead!==confirmed.head)throw Error('STALE_AUTHORITY');
  return {...verified,parent:verified.nodes.get(confirmed.head),installed:!!prior.value};
 }
 async function installedRecovery(confirmed){
  const {operationId}=householdReceiverIds(sodium,confirmed.scope,deviceId);
  const receipt=await storage.householdRecipient.find(confirmed.scope.id,operationId);
  if(!receipt.ok)throw Error(receipt.error);
  if(!receipt.value||receipt.value.expectedAuthority.acceptedParent!==confirmed.head)return null;
  const {scope,adultId}=await resolveRuntimeAuthority(storage,confirmed.scope,confirmed.pin,provider,deviceId);
  return {scope:confirmed.scope,acceptedHead:scope.branchHead,adultId};
 }
 async function installRecovery({scope:sc,bytes,claimHash,eventHash,grantHash,fresh,decisionHash,parentSnapshot}){
  bytes=checkedBytes(bytes);
  const confirmed=fresh?(await keys.list()).find(x=>x.scope.id===sc.id):{pin,scope:ownScope};
  if(!confirmed||!fresh&&sc.id!==ownScope.id)throw Error('CONFIRMATION_REQUIRED');
  const ids=fresh?householdReceiverIds(sodium,sc,deviceId):existingDeviceIds(sodium,sc,deviceId,eventHash);
  const joined={name,storage,scope:sc,pin:confirmed.pin,provider,deviceId,operationId:ids.operationId};
  const install=()=>withSecrets(secret=>installHouseholdFile({sodium,bytes,keys:secret,storage,scope:sc,pin:confirmed.pin,provider,recipientDevice:deviceId,LoroDoc,master,
   ...ids,recipientKind:'recovery',confirmedClaimHash:claimHash,confirmedDecisionHash:decisionHash,confirmedEventHash:eventHash,confirmedGrantHash:grantHash,
   confirmedParent:fresh?confirmed.head:undefined,confirmedParentSnapshot:parentSnapshot,prepareEnrollment:fresh?()=>prepareJoinedSequences(joined):undefined}));
  let result;
  try{result=await install();}
  catch(error){
   if(error.message!=='CONFLICT'||!(await storage.householdRecipient.find(sc.id,ids.operationId)).value)throw error;
   result=await install();
  }
  if(fresh){const opened=await finalizeJoinedSequences(joined);opened.sequences.close();}
  return {...result,scope:sc};
 }
 return {publish,seal,publishedFiles,install,installExisting,installRecovery,installedRecovery,readRecoveryParent,completedProof(input){
  const proof=structuredClone(input);
  return withSecrets(secret=>completedOrganizerProof(proof,secret));
 }};
}
