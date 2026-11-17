// Scratch proof preparation only. This does not install any authority or key.
import {verifyAuthority} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {checkHouseholdCeremonies} from '../authority/ceremony.mjs';
import {checkGrantManifest} from '../authority/grant.mjs';
import {durableSession} from './durable-session.mjs';
import {verifyStoredKeyPackage} from './key-package.mjs';
import {verifyCurrentSeed} from '../compromise/current-seed.mjs';
import {verifyPolicyProjection} from '../disclosure/policy-seed.mjs';
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const canon=x=>x instanceof Uint8Array?Array.from(x):Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
const equal=(a,b)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
const digest=async(p,k,v)=>{const r=await p.hash(domain(k,canon(v)));if(!(r instanceof Uint8Array)||r.length!==32)throw Error('INVALID_PROOF');return hex(r)};
/** Verify a locally retained public chain without requiring historical snapshots.
 * The caller must separately establish that this selected head was preaccepted. */
export async function verifyPublicParent(storage,scope,pin,provider){
 const sc=structuredClone(scope),raw=await storage.readPairingAuthority(sc);
 if(!raw.ok||!raw.value||!equal(raw.value.scope,sc))throw Error('INVALID_AUTHORITY');
 let state;try{state=JSON.parse(dec.decode(raw.value.authorityState))}catch{throw Error('INVALID_AUTHORITY')}
 if(hex(raw.value.authorityState)!==hex(enc.encode(JSON.stringify(canon(state))))||raw.value.acceptedParent!==state.activeHead||raw.value.authorizationSnapshot!==await digest(provider,'authority-state',state)||state.root?.householdId!==sc.id)throw Error('INVALID_AUTHORITY');
 const verified=await verifyAuthority(state,pin,provider);
 return {record:structuredClone(raw.value),state,nodes:verified.nodes};
}
/**
 * Validate a received v2 projection against independently accepted local
 * authority and the receiver's own durable completed pairing session.
 * This is NOT an installation entry point. Its output is not an authorization
 * token and must never be supplied to a transaction by an untrusted caller.
 */
export async function verifyHouseholdRecipientProof({sodium,storage,scope,pin,provider,sessionStore,keys,recipientDevice,publication,seed,policyBundle,LoroDoc}){
 // Copy caller-owned values before any asynchronous operation.
 const p=structuredClone(publication),s=structuredClone(seed),bundle=structuredClone(policyBundle),sc=structuredClone(scope);
 const ownKeys={signingSecret:new Uint8Array(keys.signingSecret),wrappingSecret:new Uint8Array(keys.wrappingSecret)};
 try {
  if(sc?.kind!=='household'||typeof recipientDevice!=='string'||!recipientDevice||!p?.nextAuthority||!p?.expectedAuthority?.record||!Array.isArray(p.documents)||p.documents.length!==1||!Array.isArray(p.packages))throw Error('MALFORMED');
  const parentProof=await verifyPublicParent(storage,sc,pin,provider),raw={value:parentProof.record},old=parentProof.state;
  if(raw.value.authorizationSnapshot!==p.expectedAuthority.record.authorizationSnapshot||raw.value.acceptedParent!==p.expectedAuthority.record.acceptedParent)throw Error('CONFLICT');
  const authority={state:old,activeHead:old.activeHead};
  let next;try{next=JSON.parse(dec.decode(p.nextAuthority.authorityState))}catch{throw Error('INVALID_AUTHORITY')}
  const admission=next.events?.at(-1),selection=next.selections?.at(-1),a=admission?.admission,grant=a?.grant,manifest=a?.manifest;
  if(!admission||!grant||!manifest||!selection||hex(p.nextAuthority.authorityState)!==hex(enc.encode(JSON.stringify(canon(next))))||!equal(p.nextAuthority.scope,sc)||!Number.isSafeInteger(raw.value.revision)||raw.value.revision>=Number.MAX_SAFE_INTEGER||!equal(next,{...old,events:[...old.events,admission],selections:[...old.selections,selection],activeHead:selection.to})||admission.event.parentHead!==authority.activeHead||selection.from!==authority.activeHead||p.nextAuthority.acceptedParent!==selection.to||await digest(provider,'authority-state',next)!==p.nextAuthority.authorizationSnapshot)throw Error('INVALID_AUTHORITY');
  if(![1,2,3].includes(manifest.version))throw Error('UNSUPPORTED_VERSION');if(manifest.version===1&&!String(manifest.schemaVersion).startsWith('registry-seed-v1|'))throw Error('UNSUPPORTED_SCHEMA');if(manifest.version!==1&&bundle?.version!==manifest.version)throw Error('INVALID_MANIFEST');
  const verified=await verifyAuthority(next,pin,provider),parent=verified.nodes.get(authority.activeHead),eventHash=await digest(provider,'event',admission.event);
  if(!parent||selection.to!==eventHash||p.admissionEventHash!==eventHash||![1,2,3].includes(manifest.version)||manifest.sourceDocument!==parent.runtime.documentId||manifest.newDocumentId!==admission.event.subject.documentId||manifest.newGeneration!==grant.newDocumentGeneration||manifest.schemaVersion!==`registry-seed-v${manifest.version}|${s.seedId}|${s.peerId}`||await digest(provider,'projection-manifest',manifest)!==grant.projectionManifestHash||p.manifest.id!==grant.projectionManifestHash||hex(p.manifest.bytes)!==hex(enc.encode(JSON.stringify(canon(manifest))))||p.documents[0].documentId!==manifest.newDocumentId||p.documents[0].generation!==manifest.newGeneration||!equal(p.documents[0].bytes,s.snapshot)||await digest(provider,'projection-snapshot',hex(s.snapshot))!==manifest.projectedStateHash)throw Error('INVALID_MANIFEST');
  if((await checkGrantManifest(parent,grant,manifest,s.snapshot,provider)).reason!=='SOURCE_AND_PROJECTION_EVIDENCE_REQUIRED')throw Error('INVALID_MANIFEST');
  if(!equal(grant.contentClasses,['pantry','recipe','shopping'])||!equal(p.seed,{seedId:s.seedId,identities:s.identities})||(manifest.version===1?(bundle!==null||p.policySeed!==undefined):!equal(p.policySeed,{bundle,bundleHash:manifest.policyBundleHash})))throw Error('INVALID_SEED');
  const seedProof=verifyCurrentSeed({LoroDoc,snapshot:s.snapshot,seed:s});if(seedProof.peers.length!==1||seedProof.peers[0]!==s.peerId||[...Object.values(parent.runtime.authorPeers),...admission.event.subject.devices.map(d=>d.peerId)].includes(s.peerId))throw Error('INVALID_SEED');
  if(manifest.version!==1)await verifyPolicyProjection({provider,pin,state:old,seed:s,bundle,expectedBundleHash:manifest.policyBundleHash,expectedSourceHead:authority.activeHead,expectedSourceDocument:manifest.sourceDocument,expectedSourceRevision:manifest.sourceRevision,LoroDoc});
  const evidence=a.ceremonies; // Stored authority encodes byte arrays; decode them below.
  const decode=x=>Array.isArray(x)?x.map(decode):x&&typeof x==='object'?(Object.keys(x).length===1&&typeof x.__bytes==='string'&&/^(?:[0-9a-f]{2})*$/.test(x.__bytes)?Uint8Array.from(x.__bytes.match(/../g)??[],v=>parseInt(v,16)):Object.fromEntries(Object.entries(x).map(([k,v])=>[k,decode(v)]))):x;
  const proofs=decode(evidence),devices=await checkHouseholdCeremonies(sodium,parent,raw.value.authorizationSnapshot,grant,proofs,provider),proof=proofs.find(x=>x.context.recipientDeviceId===recipientDevice),device=devices.find(x=>x.deviceId===recipientDevice);
  if(!proof||!device||proof.context.sponsorDeviceId!==a.localDeviceId)throw Error('INVALID_PROOF');
  const local=await durableSession(sodium,sessionStore,ownKeys,proof.transcript,proof.guard,'responder',proof.oob).evidence();
  if(local.hash!==device.transcriptHash||!equal(local.messages,proof.messages))throw Error('INVALID_PROOF');
  const releaseId=grant.keyEnvelopeRefs[grant.recipientDevices.indexOf(recipientDevice)],pkg=p.packages.find(x=>x.id===releaseId&&x.recipientDevice===recipientDevice),unsigned=Object.fromEntries(Object.entries(grant).filter(([k])=>k!=='signatures')),grantHash=await digest(provider,'current-state-grant',unsigned);
  if(!pkg||p.packages.filter(x=>x.id===releaseId||x.recipientDevice===recipientDevice).length!==1||p.grantHash!==grantHash||p.epochId!==grant.newEpochId)throw Error('INVALID_PROOF');
  const context={version:1,transcriptHash:device.transcriptHash,releaseId,scopeKind:'household',scopeId:sc.id,purpose:'data',epochId:grant.newEpochId,generation:grant.newDocumentGeneration,senderDevice:a.localDeviceId,senderSigningKey:hex(proof.transcript.initiator.signingPublicKey),senderWrappingKey:hex(proof.transcript.initiator.wrappingPublicKey),recipientDevice,recipientSigningKey:hex(proof.transcript.responder.signingPublicKey),recipientWrappingKey:device.wrappingKeyRef,policyHash:admission.event.policyHash,grantHash,projectionId:manifest.newDocumentId,manifestHash:grant.projectionManifestHash};
  verifyStoredKeyPackage(sodium,pkg.bytes,context);
  return {expectedAuthority:raw.value,nextAuthority:{scope:sc,revision:raw.value.revision+1,acceptedParent:selection.to,authorizationSnapshot:p.nextAuthority.authorizationSnapshot,authorityState:new Uint8Array(p.nextAuthority.authorityState)},context,packet:pkg.bytes,guardId:device.guardId,seed:s,policyBundle:bundle};
 } finally {ownKeys.signingSecret.fill(0);ownKeys.wrappingSecret.fill(0)}
}
