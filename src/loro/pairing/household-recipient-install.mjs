// Candidate only. A verified admission, recipient session and atomic storage are
// all required before the fresh household key is made available to the runtime.
import {verifyRevocationRecipient} from './household-revocation-package.mjs';
import {verifyHouseholdRecipientProof} from './household-recipient-proof.mjs';
import {withOpenedKeyPackage} from './key-package.mjs';
import {domain} from '../authority/validator.mjs';
import {resolveRuntimeAuthority} from '../authority/chain.mjs';
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const unhex=s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s)?Uint8Array.from(s.match(/../g),x=>parseInt(x,16)):null;
const canon=x=>x instanceof Uint8Array?Array.from(x):Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
const same=(a,b)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
const hash=async(p,name,v)=>{const b=await p.hash(domain(name,canon(v)));if(!(b instanceof Uint8Array)||b.length!==32)throw Error('INVALID_PROOF');return hex(b)};
/** Verify the recipient's durable session with its private keys before committing. */
export async function installHouseholdRecipient({sodium,storage,scope,pin,provider,sessionStore,keys,recipientDevice,publication,seed,policyBundle,LoroDoc,master,operationId,keyOperationId,recipientKind,confirmedParent,confirmedEventHash,confirmedGrantHash,prepareEnrollment}){
 if(!storage?.householdRecipient||typeof storage.localKeys!=='function'||typeof operationId!=='string'||!operationId||typeof keyOperationId!=='string'||!keyOperationId)throw Error('MALFORMED');
 // All transport data and secret material are copied before the first await.
 const p=structuredClone(publication),s=structuredClone(seed),bundle=structuredClone(policyBundle),sc=structuredClone(scope),privateKeys={signingSecret:new Uint8Array(keys.signingSecret),wrappingSecret:new Uint8Array(keys.wrappingSecret)};
 try{
  const prior=await storage.householdRecipient.find(sc.id,operationId);if(!prior.ok)throw Error(prior.error);
  const parentStorage=prior.value?{readPairingAuthority:async()=>({ok:true,value:structuredClone(prior.value.expectedAuthority)})}:storage;
  const verify=recipientKind==='revocation'?verifyRevocationRecipient:verifyHouseholdRecipientProof;
  const savedSelection=prior.value&&recipientKind==='revocation'?
   JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(prior.value.nextAuthority.authorityState)).selections.at(-1):undefined;
  const proof=await verify({sodium,storage:parentStorage,scope:sc,pin,provider,sessionStore,keys:privateKeys,recipientDevice,publication:p,seed:s,policyBundle:bundle,LoroDoc,confirmedEventHash,confirmedGrantHash,savedSelection});
  if((recipientKind!==undefined&&proof.kind!==recipientKind)||(confirmedParent!==undefined&&proof.expectedAuthority.acceptedParent!==confirmedParent))throw Error('INVALID_AUTHORITY');
  const context=proof.context,packetHash=await hash(provider,'household-recipient-packet',Array.from(proof.packet));
  const body={version:1,scopeId:sc.id,operationId,keyOperationId,guardId:proof.guardId,recipientDevice,parentHead:proof.expectedAuthority.acceptedParent,acceptedHead:proof.nextAuthority.acceptedParent,documentId:context.projectionId,epochId:context.epochId,manifestHash:context.manifestHash,grantHash:context.grantHash,policyBundleHash:bundle?p.policySeed.bundleHash:null,packetHash};
  const signed=domain('household-recipient-receipt',body),recipientKey=unhex(context.recipientSigningKey);
  if(!recipientKey)throw Error('INVALID_PROOF');
  const receipt=prior.value?new Uint8Array(prior.value.receipt):sodium.crypto_sign_detached(signed,privateKeys.signingSecret);
  if(!sodium.crypto_sign_verify_detached(receipt,signed,recipientKey)||prior.value&&!same(prior.value.receiptBody,body))throw Error('CONFLICT');
  const identity={version:1,scope:sc,deviceId:recipientDevice,purpose:'data',epochId:context.epochId};
  return await withOpenedKeyPackage(sodium,proof.packet,context,privateKeys.wrappingSecret,async key=>{
   const localKey=await storage.localKeys(master,sodium).preparePairedDataKey(keyOperationId,identity,key);
   const input={version:1,operationId,scopeId:sc.id,guardId:proof.guardId,documentId:context.projectionId,generation:context.generation,expectedAuthority:proof.expectedAuthority,nextAuthority:proof.nextAuthority,manifest:{id:context.manifestHash,bytes:new Uint8Array(p.manifest.bytes)},seed:{seedId:s.seedId,identities:structuredClone(s.identities)},policySeed:bundle?{bundle,bundleHash:p.policySeed.bundleHash}:null,snapshot:new Uint8Array(proof.snapshot??s.snapshot),packet:new Uint8Array(proof.packet),receiptBody:body,receipt,localKey};
   if(!prior.value&&proof.kind!=='newcomer'){
    const {expectedAuthority:{record}}=await resolveRuntimeAuthority(storage,sc,pin,provider,recipientDevice);
    const expected=proof.expectedAuthority;
    if(record.revision!==expected.revision||record.acceptedParent!==expected.acceptedParent||record.authorizationSnapshot!==expected.authorizationSnapshot)throw Error('CONFLICT');
   }
   if(prior.value&&proof.kind==='revocation'){
    if(!same(prior.value,input))throw Error('CONFLICT');
    const checked=await storage.householdRecipient.check(input);
    if(!checked.ok)throw Error(checked.error);
    return {replayed:true,receipt,acceptedHead:proof.nextAuthority.acceptedParent,generation:context.generation};
   }
   await prepareEnrollment?.();
   const result=await storage.householdRecipient.install(input);if(!result.ok)throw Error(result.error);return {...result.value,acceptedHead:proof.nextAuthority.acceptedParent,generation:context.generation};
  });
 }finally{privateKeys.signingSecret.fill(0);privateKeys.wrappingSecret.fill(0)}
}
