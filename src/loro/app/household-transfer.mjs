import {publishHouseholdAdmission} from '../authority/chain.mjs';
import {sealHouseholdFile,installHouseholdFile} from '../pairing/household-file.mjs';
import {prepareJoinedSequences,openJoinedSequences} from './joined-sequences.web.ts';
import {validPairingScope} from '../contracts/pairing.ts';
const enc=new TextEncoder(),hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
export function householdReceiverIds(sodium,scope,deviceId){if(!validPairingScope(scope)||scope.kind!=='household'||typeof deviceId!=='string'||!deviceId)throw Error('MALFORMED');const tag=hex(sodium.crypto_generichash(32,enc.encode(JSON.stringify([scope.id,deviceId]))));return {operationId:`receive-${tag}`,keyOperationId:`household-data-${tag}`};}
/** Trusted app dependencies are closed over; no identity key leaves withSecrets. */
export function householdTransfer({name,sodium,storage,master,provider,sessionStore,scope,pin,deviceId,runtime,service,keys,withSecrets,LoroDoc}){
 const ownScope=structuredClone(scope);
 async function publish(input){
  const data=structuredClone(input),operationId=data?.item?.event?.proposalId;if(typeof operationId!=='string'||!operationId||!(data.seed?.snapshot instanceof Uint8Array))throw Error('MALFORMED');
  const prior=await storage.getProjectionPublication(ownScope.id,operationId);if(!prior.ok)throw Error(prior.error);let pendingEdits;
  if(prior.value)pendingEdits=prior.value.pendingEdits;else{const expected=await runtime.authorize(),archive=await storage.listBranchLocalOperations(expected);if(!archive.ok)throw Error(archive.error);pendingEdits=archive.value}
  return withSecrets(async({signingSecret})=>{const result=await publishHouseholdAdmission({storage,scope:ownScope,pin,provider,master,operationId,keyOperationId:`admission-key:${operationId}`,localDeviceId:deviceId,signingSecret,item:data.item,grant:data.grant,manifest:data.manifest,snapshot:data.seed.snapshot,ceremonies:data.ceremonies,existingCeremonies:data.existingCeremonies,selection:data.selection,pendingEdits,sourceRuntime:runtime,policyBundle:data.policyBundle,disclosureService:service});return {replayed:result.replayed,operationId}});
 }
 async function seal(input){const data=structuredClone(input);if(typeof data?.operationId!=='string'||typeof data?.recipientDevice!=='string')throw Error('MALFORMED');return withSecrets(keys=>sealHouseholdFile({sodium,storage,scope:ownScope,pin,provider,sessionStore,keys,operationId:data.operationId,recipientDevice:data.recipientDevice,LoroDoc}));}
 async function install(input){
  if(!(input?.bytes instanceof Uint8Array)||input.bytes.length<48||input.bytes.length>16*1024*1024+48)throw Error('MALFORMED');const data=structuredClone(input);if(!validPairingScope(data?.scope)||data.scope.kind!=='household'||!(data.bytes instanceof Uint8Array)||data.bytes.length<48||data.bytes.length>16*1024*1024+48)throw Error('MALFORMED');const confirmed=(await keys.list()).find(x=>x.scope.kind==='household'&&x.scope.id===data.scope.id);if(!confirmed)throw Error('CONFIRMATION_REQUIRED');
  const {operationId,keyOperationId}=householdReceiverIds(sodium,data.scope,deviceId),prior=await storage.householdRecipient.find(data.scope.id,operationId);if(!prior.ok)throw Error(prior.error);if(prior.value){if(prior.value.expectedAuthority.acceptedParent!==confirmed.head)throw Error('INVALID_AUTHORITY')}else{const authority=await storage.readPairingAuthority(data.scope);if(!authority.ok||!authority.value||authority.value.acceptedParent!==confirmed.head)throw Error('INVALID_AUTHORITY')}
  const joined={name,storage,scope:data.scope,pin:confirmed.pin,provider,deviceId,operationId};await prepareJoinedSequences(joined);
  const result=await withSecrets(secret=>installHouseholdFile({sodium,bytes:data.bytes,keys:secret,storage,scope:data.scope,pin:confirmed.pin,provider,sessionStore,recipientDevice:deviceId,LoroDoc,master,operationId,keyOperationId}));const opened=await openJoinedSequences(joined);opened.sequences.close();return {replayed:result.replayed,scope:structuredClone(data.scope),selected:false};
 }
 return {publish,seal,install};
}
