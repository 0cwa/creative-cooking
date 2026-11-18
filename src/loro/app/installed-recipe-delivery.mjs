import {candidateCodec,candidateObjectId} from '../crypto/candidate.mjs';
import {domain} from '../authority/validator.mjs';
import {isRecipeDocumentId,recipeDocumentId} from '../domain/recipe-document.mjs';
import {makeKeyPackage,verifyStoredKeyPackage,withOpenedKeyPackage} from '../pairing/key-package.mjs';
import {MAX_OBJECT} from '../transport/adapter.mjs';
import {localProvider} from './local-provider.mjs';
import {readRecipeCatalog,verifyRecipeCreation} from './selected-recipe-catalog.mjs';

const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const keyRef=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const packageLimit=16384;

function splitDelivery(bytes) {
 const text=decoder.decode(bytes),record=JSON.parse(text);
 if(!record||!Object.hasOwn(record,'recipeDelivery'))return null;
 const {recipeDelivery,...inner}=record;
 const packets=recipeDelivery?.packets;
 if(recipeDelivery?.version!==1)throw Error('UNSUPPORTED_VERSION');
 if(bytes.length>MAX_OBJECT||!Array.isArray(packets)||!packets.length||packets.length>32||
    Object.keys(recipeDelivery).length!==2||
    packets.some(packet=>!Array.isArray(packet)||packet.length!==2||typeof packet[0]!=='string'||
      typeof packet[1]!=='string'||!packet[1].length||packet[1].length%2||
      packet[1].length>2*packageLimit||!/^[0-9a-f]+$/.test(packet[1]))||
    JSON.stringify({...inner,recipeDelivery:{version:1,packets}})!==text)throw Error('MALFORMED');
 return {header:inner.header,inner:encoder.encode(JSON.stringify(inner)),packets};
}

export function hasRecipeDelivery(bytes) {
 if(bytes.length>MAX_OBJECT)throw Error('TOO_LARGE');
 const record=JSON.parse(decoder.decode(bytes));
 return record!=null&&Object.hasOwn(record,'recipeDelivery');
}

export function installedRecipeDelivery({sodium,keys,signing,wrapping,provider,pin,resolved,baselineContent}) {
 const {scope}=resolved;
 const baseIds=new Set(resolved.members.map(member=>member.documentId));
 const hash=async(purpose,value)=>sodium.to_hex(await provider.hash(domain(purpose,value)));
 const onHead=h=>h?.scopeId===scope.scopeId&&h.branchHead===scope.branchHead&&h.epochId===scope.epochId&&
   h.documentGeneration===scope.documentGeneration;
 const childRoute=h=>onHead(h)&&isRecipeDocumentId(h.documentId)&&!baseIds.has(h.documentId);
 async function keySlot(documentId){
  const epochId=await hash('installed-recipe-key-slot-v1',{
   pin,scopeId:scope.scopeId,head:scope.branchHead,epochId:scope.epochId,
   generation:scope.documentGeneration,documentId
  });
  const operationId=await hash('installed-recipe-key-operation-v1',{epochId,deviceId:scope.authorDevice});
  return {operationId,identity:{version:1,scope:{kind:'household',id:scope.scopeId},deviceId:scope.authorDevice,purpose:'data',epochId}};
 }
 async function useContent(ref,fn,header){
  if(!childRoute(header))return baselineContent(ref,fn,header);
  if(ref!==scope.epochId)throw Error('INVALID_AUTHORITY');
  const {operationId,identity}=await keySlot(header.documentId);
  // Candidate AEAD runs only after the signed header has been verified.
  let keyFound=false;
  try{return await keys.use(operationId,identity,key=>{keyFound=true;return fn(key);});}
  catch(error){if(!keyFound&&error?.message==='NOT_FOUND')throw Error('RECIPE_CREATION_REQUIRED');throw error;}
 }
 const candidate=content=>candidateCodec(localProvider(sodium,keys,{signing,content}));
 const base=candidate(useContent);
 const withKey=(documentId,key)=>candidate((ref,fn,h)=>{
  if(ref===scope.epochId&&childRoute(h)&&h.documentId===documentId)return fn(key);
  throw Error('INVALID_AUTHORITY');
 });
 async function contexts(h,innerId,auth){
  const eligible=scope.acceptedRecipients;
  if(!childRoute(h)||!eligible.includes(h.authorDevice)||![2,3,4].includes(h.version))throw Error('INVALID_AUTHORITY');
  if(eligible.length<2||eligible.length>33||eligible.some(id=>!scope.acceptedAuthors.includes(id)||
      !keyRef(auth.signingKeyRefs[id])||!keyRef(auth.wrappingKeyRefs?.[id]))||
      new Set(eligible.map(id=>auth.wrappingKeyRefs[id])).size!==eligible.length)throw Error('INVALID_AUTHORITY');
  const recipients=eligible.filter(id=>id!==h.authorDevice).sort();
  return Promise.all(recipients.map(async recipientDevice=>({
   version:1,transcriptHash:scope.authorizationSnapshot,
   releaseId:await hash('installed-recipe-key-delivery-v1',{pin,head:h.branchHead,innerId,
    scopeId:h.scopeId,epochId:h.epochId,generation:h.documentGeneration,documentId:h.documentId,
    senderDevice:h.authorDevice,recipientDevice}),
   scopeKind:'household',scopeId:scope.scopeId,purpose:'installed-recipe-data-v1',
   epochId:scope.epochId,generation:scope.documentGeneration,senderDevice:h.authorDevice,
   senderSigningKey:auth.signingKeyRefs[h.authorDevice],senderWrappingKey:auth.wrappingKeyRefs[h.authorDevice],
   recipientDevice,recipientSigningKey:auth.signingKeyRefs[recipientDevice],recipientWrappingKey:auth.wrappingKeyRefs[recipientDevice],
   policyHash:scope.policyHashes[0],grantHash:scope.branchHead,projectionId:h.documentId,manifestHash:innerId,
  })));
 }
 async function verifyDelivery(bytes,auth){
  const split=splitDelivery(bytes);
  if(!split)throw Error('INVALID_PROOF');
  const {inner,header,packets}=split;
  const expected=await contexts(header,await candidateObjectId(provider,inner),auth);
  if(expected.length!==packets.length)throw Error('INVALID_PROOF');
  const verified=expected.map((context,index)=>{
   const [deviceId,encoded]=packets[index];
   if(deviceId!==context.recipientDevice)throw Error('INVALID_PROOF');
   const packet=sodium.from_hex(encoded);
   verifyStoredKeyPackage(sodium,packet,context);
   return {context,packet};
  });
  return {...split,verified,object:{id:await candidateObjectId(provider,bytes),bytes}};
 }
 async function openVerified(delivery,codec,refs){
  const opened=await codec.openContent(delivery.inner,refs);
  return {...opened,object:delivery.object,recipeDelivery:true};
 }
 const codec={...base,openContent:async(bytes,refs)=>{
  if(!hasRecipeDelivery(bytes))return base.openContent(bytes,refs);
  const delivery=await verifyDelivery(bytes,{...resolved,signingKeyRefs:refs});
  return openVerified(delivery,base,refs);
 }};
 async function assertLocalKeys(auth){
  if(auth.signingKeyRefs[scope.authorDevice]!==signing.publicKey)throw Error('INVALID_KEY');
  await keys.use(wrapping.operationId,wrapping.identity,secret=>{
   if(sodium.to_hex(sodium.crypto_scalarmult_base(secret))!==auth.wrappingKeyRefs?.[scope.authorDevice])throw Error('INVALID_KEY');
  });
 }
 async function create(runtime,recipeId,execute) {
  const auth=await runtime.authorization();
  await assertLocalKeys(auth);
  const documentId=await recipeDocumentId(scope,pin,provider,recipeId);
  const {operationId,identity}=await keySlot(documentId);
  const key=sodium.randombytes_buf(32);
  try{
   const temporary=withKey(documentId,key);
   const creating={...codec,sealContent:async(h,p,ref,signRef)=>{
    const inner=await temporary.sealContent(h,p,ref,signRef);
    const recipients=await contexts(h,inner.id,auth);
    const packets=await keys.use(signing.operationId,signing.identity,secret=>recipients.map(context=>{
     const packet=makeKeyPackage(sodium,context,key,secret);
     verifyStoredKeyPackage(sodium,packet,context);
     return [context.recipientDevice,sodium.to_hex(packet)];
    }));
    const bytes=encoder.encode(JSON.stringify({...JSON.parse(decoder.decode(inner.bytes)),recipeDelivery:{version:1,packets}}));
    return {id:await candidateObjectId(provider,bytes),bytes};
   }};
   const worker=await runtime.forRecipe(recipeId,{codec:creating,prepareKey:()=>keys.preparePairedDataKey(operationId,identity,key)});
   const result=await execute(worker);
   if(result.replayed)await runtime.forRecipe(recipeId);
   return result;
  }finally{key.fill(0);}
 }
 async function receive(runtime,bytes,apply) {
  const auth=await runtime.authorization();
  const delivery=await verifyDelivery(bytes,auth),{documentId}=delivery.header;
  const addressed=delivery.verified.find(entry=>entry.context.recipientDevice===scope.authorDevice);
  if(!addressed)throw Error('INVALID_AUTHORITY');
  await assertLocalKeys(auth);
  return keys.use(wrapping.operationId,wrapping.identity,secret=>
   withOpenedKeyPackage(sodium,addressed.packet,addressed.context,secret,async key=>{
    const temporary=withKey(documentId,key);
    const opened=await openVerified(delivery,temporary,auth.signingKeyRefs);
    const {recipeId}=await verifyRecipeCreation(runtime,{...scope,documentId},opened,delivery.object.id);
    if(documentId!==await recipeDocumentId(scope,pin,provider,recipeId))throw Error('INVALID_RECIPE_DOCUMENT');
    const importing={...codec,openContent:(input,refs)=>input.length===bytes.length&&input.every((byte,index)=>byte===bytes[index])
     ? openVerified(delivery,temporary,refs) : codec.openContent(input,refs)};
    const {operationId,identity}=await keySlot(documentId);
    const worker=await runtime.forRecipe(recipeId,{codec:importing,prepareKey:()=>keys.preparePairedDataKey(operationId,identity,key)});
    const {children}=await readRecipeCatalog(runtime,auth,recipeId);
    const existing=children.get(recipeId);
    if(existing&&existing.creationObjectId!==delivery.object.id)throw Error('CONFLICT');
    return apply(worker,opened,auth,async()=>{
     // An applied replay must still have its authenticated catalog and usable key.
     await runtime.forRecipe(recipeId);
    });
   }));
 }
 async function authorizeDownload(runtime,bytes,objectId,auth) {
  const {verified,header,object}=await verifyDelivery(bytes,auth);
  if(object.id!==objectId||header.authorDevice!==scope.authorDevice)throw Error('INVALID_AUTHORITY');
  const devices=[scope.authorDevice,...verified.map(({context})=>context.recipientDevice)];
  const result=await runtime.storage.checkRecipeDeliveryRecipients(auth.expectedAuthority,devices);
  if(!result.ok)throw Error(result.error.code??result.error);
 }
 return {codec,create,receive,authorizeDownload,recipeCatalog:readRecipeCatalog};
}
