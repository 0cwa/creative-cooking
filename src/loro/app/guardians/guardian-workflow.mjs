import {createGuardians,restorePersonal} from '../../recovery/recovery.mjs';
import {openRecoveryArchive,createRecoveryArchive} from '../recovery-archive.mjs';
import {personalRecovery} from '../personal-recovery.mjs';
import {validLocalRecord} from '../../storage/local-keys.ts';
import {resolvePersonalAuthority,importPersonalAuthorityHistory} from '../../authority/personal.mjs';
import {verifyEnrollment,enrollmentBytes,recoveryHash,reconstructEnrolled,makeEnrolledContribution} from '../../recovery/enrollment.mjs';
import {recoveryLifecycle,custodyAcknowledgementBytes} from '../../recovery/lifecycle.mjs';
export const MAX_GUARDIAN_MESSAGE=512*1024;
const e=new TextEncoder(),d=new TextDecoder('utf-8',{fatal:true}),key=(...parts)=>JSON.stringify(parts);
export function guardianTransferText(value){const text=JSON.stringify(value);if(typeof text!=='string'||e.encode(text).length>MAX_GUARDIAN_MESSAGE)throw Error('GUARDIAN_MESSAGE_TOO_LARGE');return text}
export function parseGuardianTransfer(text){if(typeof text!=='string'||e.encode(text).length>MAX_GUARDIAN_MESSAGE)throw Error('GUARDIAN_MESSAGE_TOO_LARGE');return JSON.parse(text)}
const id=x=>typeof x==='string'&&x.length>0&&e.encode(x).length<=128;
const hex=x=>Array.from(x,n=>n.toString(16).padStart(2,'0')).join('');
const unhex=(x,n)=>{if(typeof x!=='string'||!new RegExp(`^[0-9a-f]{${n*2}}$`).test(x))throw Error('INVALID_INPUT');return Uint8Array.from(x.match(/../g),y=>parseInt(y,16))};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const pinKey=(holder,authorityPin)=>authorityPin===undefined
 ?key('recovery-custody-ack','pinned-holder',holder)
 :key('recovery-custody-ack','pinned-owner-holder',authorityPin,holder);
const draftKey=(owner,operation)=>key('recovery-generation-operation','guardian-draft',owner,operation);
const draftAAD=(owner,operation)=>e.encode(JSON.stringify(['creative-cooking/guardian-draft/v1',owner,operation]));
const publicBundle=x=>x&&Object.keys(x).sort().join(',')==='holder,signingKey,version,wrappingKey'&&x.version===1&&id(x.holder)&&/^[0-9a-f]{64}$/.test(x.signingKey)&&/^[0-9a-f]{64}$/.test(x.wrappingKey);
export function holderFingerprint(sodium,bundle){if(!publicBundle(bundle))throw Error('INVALID_HOLDER');return hex(sodium.crypto_generichash(32,e.encode(JSON.stringify(['creative-cooking/guardian-pin/v1',bundle.holder,bundle.signingKey,bundle.wrappingKey]))))}
/** Transfer only a signed root. The receiver separately compares its root pin with the owner. */
export async function exportGuardianAuthority({storage,authorityProvider,scopeId,pin,deviceId}){const resolved=await resolvePersonalAuthority(storage,{kind:'personal',id:scopeId},pin,authorityProvider,deviceId),read=await storage.readPairingAuthority({kind:'personal',id:scopeId});if(!read.ok)throw Error(read.error);let state;try{state=JSON.parse(d.decode(read.value.authorityState))}catch{throw Error('INVALID_AUTHORITY')}if(![1,2,3].includes(state?.version))throw Error('UNSUPPORTED_AUTHORITY_HISTORY');return {version:1,scopeId,owner:resolved.scope.ownerId,deviceId,pin,state}}
export async function acceptGuardianAuthority({storage,authorityProvider,bundle,confirmedPin}){guardianTransferText(bundle);bundle=structuredClone(bundle);if(!bundle||Object.keys(bundle).sort().join(',')!=='deviceId,owner,pin,scopeId,state,version'||bundle.version!==1||![bundle.scopeId,bundle.owner,bundle.deviceId,bundle.pin].every(id)||bundle.pin!==confirmedPin||![1,2,3].includes(bundle.state?.version))throw Error('INVALID_AUTHORITY');const scope={kind:'personal',id:bundle.scopeId},result=await importPersonalAuthorityHistory(storage,scope,bundle.pin,authorityProvider,bundle.state,bundle.owner,bundle.deviceId),resolved=await resolvePersonalAuthority(storage,scope,bundle.pin,authorityProvider,bundle.deviceId);if(resolved.scope.ownerId!==bundle.owner)throw Error('INVALID_AUTHORITY');return result}

/** Generates a holder-specific signing and wrapping identity in that holder's own personal store. */
export async function initializeGuardianHolder({keys,scopeId,deviceId,holder}){if(![scopeId,deviceId,holder].every(id)||typeof keys?.generate!=='function')throw Error('INVALID_INPUT');const identity=purpose=>({version:1,scope:{kind:'personal',id:scopeId},deviceId,purpose,epochId:'guardian-v1'}),tag=encodeURIComponent(holder);if(e.encode(tag).length>120)throw Error('INVALID_INPUT');const signing={operationId:`guardian-sign:${tag}`,identity:identity('device-signing')},wrapping={operationId:`guardian-wrap:${tag}`,identity:identity('device-wrapping')},a=await keys.generate(signing.operationId,signing.identity),b=await keys.generate(wrapping.operationId,wrapping.identity);if(!(a.publicKey instanceof Uint8Array)||a.publicKey.length!==32||!(b.publicKey instanceof Uint8Array)||b.publicKey.length!==32)throw Error('INVALID_HOLDER_KEY');return {bundle:{version:1,holder,signingKey:hex(a.publicKey),wrappingKey:hex(b.publicKey)},signing,wrapping}}
/** The human must compare the displayed fingerprint over an independent channel. Pins are immutable here.
 * @param {{sodium:any,run:any,bundle:unknown,confirmedFingerprint:string,authorityPin?:string}} options
 */
export async function pinHolder({sodium,run,bundle,confirmedFingerprint,authorityPin=undefined}){
 bundle=structuredClone(bundle);if(authorityPin!==undefined&&(typeof authorityPin!=='string'||!/^[0-9a-f]{64}$/.test(authorityPin))||
  holderFingerprint(sodium,bundle)!==confirmedFingerprint)throw Error('INVALID_HOLDER_PIN');
 return run(true,async tx=>{const slot=pinKey(bundle.holder,authorityPin),old=await tx.get(slot);if(old!==undefined){if(!equal(old,bundle))throw Error('CONFLICT');return {replayed:true}}await tx.put(slot,bundle);return {replayed:false}});
}
async function pinned(run,holders,authorityPin,historicalRoster){
 const pins=Object.create(null);
 for(const holder of holders){
  const enrolled=historicalRoster?.get(holder);
  const matches=b=>publicBundle(b)&&b.holder===holder&&
   (!enrolled||b.signingKey===enrolled.signingKey&&b.wrappingKey===enrolled.wrappingKey);
  const bundle=await run(false,async tx=>{
   const scoped=await tx.get(pinKey(holder,authorityPin));
   if(matches(scoped)||!enrolled)return scoped;
   // Legacy pins may verify a named historical share. New shares require a root-scoped pin.
   return tx.get(pinKey(holder));
  });
  if(!matches(bundle))throw Error('MISSING_HOLDER_PIN');
  pins[holder]={signingKey:bundle.signingKey,wrappingKey:bundle.wrappingKey};
 }
 return pins;
}
/** Owner prepares a stable, wrapped draft before publishing a generation. The supplied kit and
 * catalog must be produced locally by the accepted personal workspace and never from a holder. */
export function ownerGuardians({sodium,run,storage,authorityProvider,scopeId,owner,deviceId,pin,keys,signing,master,masterId}){
 const life=recoveryLifecycle({sodium,run,master,masterId});
 async function historicalPins(manifest){
  if(manifest?.authorityPin!==pin||manifest.scopeId!==scopeId||manifest.owner!==owner||
   !Array.isArray(manifest.roster)||manifest.roster.length>255||
   Array.from(manifest.roster).some(row=>!id(row?.holder)))throw Error('INVALID_ENROLLMENT');
  const roster=new Map(manifest.roster.map(row=>[row.holder,row]));
  return pinned(run,[...roster.keys()],pin,roster);
 }
 async function prepare({operationId,catalog,personalKit,archive,holders,threshold}){
  ({catalog,personalKit,archive,holders}=structuredClone({catalog,personalKit,archive,holders}));
  if(!id(operationId)||!Array.isArray(holders)||holders.length<1||holders.length>255||holders.some(x=>!id(x))||new Set(holders).size!==holders.length||!Number.isInteger(threshold)||threshold<1||threshold>holders.length||catalog?.owner!==owner)throw Error('INVALID_INPUT');
  const resolved=await resolvePersonalAuthority(storage,{kind:'personal',id:scopeId},pin,authorityProvider,deviceId);if(resolved.scope.ownerId!==owner)throw Error('INVALID_AUTHORITY');
  const slot=draftKey(owner,operationId);
  const {draftRecord,published}=await run(false,async tx=>({
   draftRecord:await tx.get(slot),published:await tx.get(key('recovery-generation-operation',owner,operationId))
  }));
  let saved=draftRecord;
  const pins=saved!==undefined&&published!==undefined
   ?await historicalPins((await readDraft(operationId,saved)).manifest)
   :await pinned(run,holders,pin);
  const requestHash=recoveryHash(sodium,[catalog,personalKit,archive,holders,threshold,pins,pin,deviceId]);
  if(saved===undefined){
   const hash=recoveryHash(sodium,catalog),wrapping=Object.fromEntries(holders.map(holder=>[holder,unhex(pins[holder].wrappingKey,32)])),guardian=await createGuardians(sodium,personalKit,holders,threshold,{owner,scope:'personal',generation:catalog.generation,catalogHash:hash,consent:operationId,grant:null},wrapping);
   const manifest={...(resolved.rotation?{version:2,epochId:resolved.scope.epochId,
    authoritySnapshot:resolved.scope.authorizationSnapshot}:{version:1}),owner,scopeId,authorityPin:pin,signerDevice:deviceId,generation:catalog.generation,catalogHash:hash,roster:holders.map((holder,i)=>({holder,...pins[holder],shareHash:recoveryHash(sodium,guardian.envelopes[i])})),threshold,purpose:'personal-recovery',packageHash:recoveryHash(sodium,guardian.package),personalKitHash:recoveryHash(sodium,personalKit)};
   const signature=await keys.use(signing.operationId,signing.identity,secret=>{const pair=sodium.crypto_sign_seed_keypair(secret.slice(0,32));try{if(hex(pair.publicKey)!==resolved.signingKeyRefs[deviceId])throw Error('INVALID_AUTHORITY');return hex(sodium.crypto_sign_detached(enrollmentBytes(manifest),secret))}finally{pair.privateKey.fill(0)}});
   guardianTransferText({version:1,manifest,signature,catalog,guardianPackage:guardian.package,envelopes:guardian.envelopes});const draft={manifest,signature,catalog,guardianPackage:guardian.package,envelopes:guardian.envelopes,holderPins:pins,personalKit,archive};const input={sodium,storage,authorityProvider,pin,...draft};await verifyEnrollment(input);
   const clear=e.encode(JSON.stringify(draft));let sealed;try{sealed=await master.wrap(masterId,clear,draftAAD(owner,operationId))}finally{clear.fill(0)}
   saved=await run(true,async tx=>{const existing=await tx.get(slot);if(existing!==undefined){if(existing.requestHash!==requestHash)throw Error('CONFLICT');return existing}const head=await tx.get(key('recovery-generation-head',owner));if(head===undefined?(catalog.generation!==0||catalog.previousCatalogHash!==null):(!head||catalog.generation!==head.generation+1||catalog.previousCatalogHash!==head.catalogHash))throw Error('CONFLICT');const reservationKey=key('recovery-generation-operation','guardian-reservation',owner,String(catalog.generation)),prior=await tx.get(reservationKey);if(prior!==undefined&&(!prior||prior.operationId!==operationId||prior.requestHash!==requestHash))throw Error('CONFLICT');const record={version:1,requestHash,sealed};await tx.put(reservationKey,{version:1,operationId,requestHash});await tx.put(slot,record);return record});
  }
  if(!saved||saved.version!==1||saved.requestHash!==requestHash||!(saved.sealed instanceof Uint8Array))throw Error('CONFLICT');let bytes;let draft;try{bytes=await master.unwrap(masterId,saved.sealed,draftAAD(owner,operationId));draft=JSON.parse(d.decode(bytes))}finally{bytes?.fill(0)}
  const input={sodium,storage,authorityProvider,pin,...draft};const status=await life.begin({operationId,enrollment:input,personalKit:draft.personalKit,
   expectedAuthority:resolved.expectedAuthority,rotated:!!resolved.rotation});
  const {personalKit:_,holderPins:__,archive:___,...message}=draft;
  return {message:{version:1,...message},recovery:{code:draft.personalKit.code,archive:draft.archive},status:{generation:status.generation,rotationStatus:status.rotationStatus,threshold,holders:[...holders],holderReadAccess:`${threshold} holders can read the recovered personal package`,householdAuthority:'readmission-required'}};
 }
 async function prepareFromArchive({archive,code,operationId,holders,threshold}){const verified=await openRecoveryArchive(sodium,archive,code),body=verified.body;if(body.owner!==owner||body.scopeId!==scopeId||body.pin!==pin||body.deviceId!==deviceId)throw Error('INVALID_AUTHORITY');const map=new Map(body.bindings.map(x=>[x.ref,x]));await restorePersonal(sodium,body.package,code,{owner,generation:body.catalog.generation},{installPersonalDataKeys:async(requestOwner,items)=>{if(requestOwner!==owner||items.length!==map.size)throw Error('INVALID_AUTHORITY');for(const item of items){const binding=map.get(item.ref);if(!binding)throw Error('INVALID_AUTHORITY');await keys.use(binding.operationId,binding.identity,secret=>{if(!sodium.memcmp(secret,item.key))throw Error('INVALID_AUTHORITY')})}},hasEncryptedObject:async()=>false});return prepare({operationId,catalog:body.catalog,personalKit:{code,package:body.package},archive,holders,threshold})}
 async function createGeneration({operationId,holders,threshold,expectedSnapshot}){({operationId,holders,threshold}=structuredClone({operationId,holders,threshold}));if(!id(operationId))throw Error('INVALID_INPUT');if(await run(false,tx=>tx.get(draftKey(owner,operationId)))!==undefined){const draft=await readDraft(operationId);if(draft.manifest.threshold!==threshold||!equal(draft.manifest.roster.map(x=>x.holder),holders))throw Error('CONFLICT');return resume({operationId});}const resolved=await resolvePersonalAuthority(storage,{kind:'personal',id:scopeId},pin,authorityProvider,deviceId);if(resolved.scope.ownerId!==owner)throw Error('INVALID_AUTHORITY');if(expectedSnapshot&&expectedSnapshot!==resolved.scope.authorizationSnapshot)throw Error('CONFLICT');const records=await run(false,async tx=>{const found=[];for(const slot of await tx.keys()){let parts;try{parts=JSON.parse(slot)}catch{continue}if(parts[0]!=='local-key'||parts[1]!=='personal'||parts[2]!==scopeId||parts[3]!==deviceId||parts[4]!=='data'||parts[5]!==resolved.scope.epochId)continue;const record=await tx.get(slot);if(!validLocalRecord(record))throw Error('LOCKED');found.push(record)}return found});if(records.length!==1)throw Error('MISSING_KEY');const record=records[0];await keys.use(record.operationId,record.identity,()=>undefined);const bindings=[{ref:resolved.scope.epochId,operationId:record.operationId,identity:record.identity}],objects=await storage.listOutboundObjects(scopeId);if(!objects.ok)throw Error(objects.error);const head=await run(false,tx=>tx.get(key('recovery-generation-head',owner))),catalog={version:1,owner,generation:head===undefined?0:head.generation+1,previousCatalogHash:head===undefined?null:head.catalogHash,keyRefs:[resolved.scope.epochId],encryptedObjectRefs:objects.value.filter(x=>x.epochId===resolved.scope.epochId).map(x=>x.objectId),trustedCheckpoints:resolved.rotation?[resolved.scope.branchHead]:[],custodyLocations:[]};const recovery=personalRecovery({sodium,keys,run,storage,master,masterId,owner,scopeId,bindings,operationId:`guardian-export:${operationId}`}),kit=await recovery.create(catalog),archive=await createRecoveryArchive({sodium,storage,keys,scopeId,owner,deviceId,pin,catalog,bindings,kit,includeObjects:true,includeSnapshot:true});return prepare({operationId,catalog,personalKit:kit,archive,holders,threshold})}
 async function readDraft(operationId,record=undefined){if(!id(operationId))throw Error('INVALID_INPUT');const saved=record??await run(false,tx=>tx.get(draftKey(owner,operationId)));if(!saved||saved.version!==1||!(saved.sealed instanceof Uint8Array))throw Error('MISSING_DRAFT');let clear,draft;try{clear=await master.unwrap(masterId,saved.sealed,draftAAD(owner,operationId));draft=JSON.parse(d.decode(clear))}finally{clear?.fill(0)}if(!draft?.manifest||!Array.isArray(draft.manifest.roster)||draft.manifest.roster.some(x=>!id(x?.holder))||!Number.isInteger(draft.manifest.threshold))throw Error('INVALID_INPUT');return draft}
 async function resume({operationId}){const draft=await readDraft(operationId);const holders=draft.manifest.roster.map(x=>x.holder);return prepare({operationId,catalog:draft.catalog,personalKit:draft.personalKit,archive:draft.archive,holders,threshold:draft.manifest.threshold})}
 async function acknowledge({operationId,message,holder,signature}){const parts=strip(message),holderPins=await historicalPins(parts.manifest);return life.acknowledge({operationId,enrollment:{sodium,storage,authorityProvider,pin,...parts,holderPins},holder,signature})}
 async function custodyStatus({operationId,message}){if(!id(operationId))throw Error('INVALID_INPUT');const parts=strip(message),holderPins=await historicalPins(parts.manifest),input={sodium,storage,authorityProvider,pin,...parts,holderPins},verified=await verifyEnrollment(input),manifest=verified.manifest,representation=recoveryHash(sodium,[manifest,parts.signature,parts.catalog,parts.guardianPackage,parts.envelopes]),stored=await run(false,tx=>tx.get(key('recovery-generation-operation',owner,operationId)));if(!stored||stored.representation!==representation)throw Error('CONFLICT');const acknowledged=[],pending=[];for(const row of manifest.roster){const record=await run(false,tx=>tx.get(key('recovery-custody-ack',owner,String(manifest.generation),row.holder)));if(record===undefined){pending.push(row.holder);continue}if(!record||record.version!==1||record.holder!==row.holder||record.representation!==representation||!sodium.crypto_sign_verify_detached(unhex(record.signature,64),custodyAcknowledgementBytes(recoveryHash(sodium,manifest),row.holder,row.shareHash),unhex(row.signingKey,32)))throw Error('INVALID_PROOF');acknowledged.push(row.holder)}return {generation:manifest.generation,threshold:manifest.threshold,acknowledged,pending,rotationStatus:stored.rotationStatus}}
 async function reconstruct({message,contributions}){guardianTransferText(contributions);const parts=strip(message),holderPins=await historicalPins(parts.manifest);return reconstructEnrolled({sodium,storage,authorityProvider,pin,...parts,holderPins},contributions)}
 return {createGeneration,prepareFromArchive,resume,acknowledge,custodyStatus,reconstruct};
}
function strip(message){guardianTransferText(message);if(!message||message.version!==1||Object.keys(message).sort().join(',')!=='catalog,envelopes,guardianPackage,manifest,signature,version')throw Error('INVALID_INPUT');const {version:_,...rest}=structuredClone(message);return rest}
/** Restore on a separate device with only independently pinned authority and holder keys. */
export function guardianReconstructor({sodium,run,storage,authorityProvider,pin}){return {async reconstruct({message,contributions}){guardianTransferText(contributions);const parts=strip(message),holderPins=await pinned(run,parts.manifest.roster.map(x=>x.holder));return reconstructEnrolled({sodium,storage,authorityProvider,pin,...parts,holderPins},contributions)}}}
/** Holder has its own independently pinned enrollment context, LocalKeys and durable store. */
export function holderGuardians({sodium,run,storage,authorityProvider,pin,holder,keys,signing,wrapping}){
 const context=async message=>{const parts=strip(message),holderPins=await pinned(run,parts.manifest.roster.map(x=>x.holder));return {sodium,storage,authorityProvider,pin,...parts,holderPins}};
 async function verifyKeys(holderPins){const expected=holderPins[holder];if(!expected)throw Error('INVALID_HOLDER_PIN');await keys.use(signing.operationId,signing.identity,secret=>{const pair=sodium.crypto_sign_seed_keypair(secret.slice(0,32));try{if(hex(pair.publicKey)!==expected.signingKey)throw Error('INVALID_HOLDER_KEY')}finally{pair.privateKey.fill(0)}});await keys.use(wrapping.operationId,wrapping.identity,secret=>{if(hex(sodium.crypto_scalarmult_base(secret))!==expected.wrappingKey)throw Error('INVALID_HOLDER_KEY')})}
 async function accept(message){const input=await context(message),verified=await verifyEnrollment(input);await verifyKeys(input.holderPins);const row=verified.manifest.roster.find(x=>x.holder===holder);if(!row)throw Error('INVALID_HOLDER_KEY');
  // Acknowledgement follows successful opening: signing without possessing the share is insufficient.
  await keys.use(wrapping.operationId,wrapping.identity,secret=>keys.use(signing.operationId,signing.identity,sign=>makeEnrolledContribution(input,holder,unhex(row.wrappingKey,32),secret,b=>sodium.crypto_sign_detached(b,sign))));
  const hash=recoveryHash(sodium,verified.manifest),signature=await keys.use(signing.operationId,signing.identity,secret=>hex(sodium.crypto_sign_detached(custodyAcknowledgementBytes(hash,holder,row.shareHash),secret)));
  const slot=key('recovery-custody-ack','holder-copy',verified.manifest.owner,String(verified.manifest.generation),holder),value={version:1,message:structuredClone(message),signature};
  return run(true,async tx=>{const old=await tx.get(slot);if(old!==undefined){if(!equal(old,value))throw Error('CONFLICT');return {holder,signature,replayed:true}}await tx.put(slot,value);return {holder,signature,replayed:false}});
 }
 async function contribute({owner,generation}){if(!id(owner)||!Number.isSafeInteger(generation)||generation<0)throw Error('INVALID_INPUT');const record=await run(false,tx=>tx.get(key('recovery-custody-ack','holder-copy',owner,String(generation),holder)));if(!record||record.version!==1)throw Error('MISSING_CUSTODY');const input=await context(record.message);await verifyEnrollment(input);await verifyKeys(input.holderPins);const row=input.manifest.roster.find(x=>x.holder===holder);return keys.use(wrapping.operationId,wrapping.identity,secret=>keys.use(signing.operationId,signing.identity,sign=>makeEnrolledContribution(input,holder,unhex(row.wrappingKey,32),secret,b=>sodium.crypto_sign_detached(b,sign))));}
 return {accept,contribute};
}
