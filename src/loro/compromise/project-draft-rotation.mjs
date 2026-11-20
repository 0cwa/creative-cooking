import {authorityBytes} from '../authority/chain.mjs';
import {isPolicyDocumentId} from '../authority/validator.mjs';
import {MAX_SELECTED_SET_BYTES} from '../contracts/runtime-storage.ts';
import {isRecipeDocumentId} from '../domain/recipe-document.mjs';
import {assemblePolicyProjection,verifyPolicyProjection} from '../disclosure/policy-seed.mjs';
import {disclosureService} from '../disclosure/service.mjs';
import {createSourceVerifier} from '../disclosure/source-proof.mjs';
import {selectedSourceHash} from '../projection/selected-sources.mjs';
import {checkedDraftSource} from './checked-draft-source.mjs';
import {projectCurrentSeed,verifyCurrentSeed} from './current-seed.mjs';
import {sameReportValue} from './report.mjs';
import {selectedOperationReportService} from './selected-report-service.mjs';

const id=value=>typeof value==='string'&&value.length>0&&new TextEncoder().encode(value).length<=256;
const must=result=>{if(!result.ok)throw Error(result.error?.code??result.error);return result.value;};
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const mapName=(kind,entity)=>kind+':'+encodeURIComponent(entity);
function loadDoc(LoroDoc,bytes){
 const doc=new LoroDoc();
 if(bytes?.length)doc.import(bytes);
 return doc;
}

function checkDestination(destination,parent,nodes){
 if(!destination||Object.keys(destination).sort().join(',')!=='documentId,epochId,generation,parentHead'||
    destination.parentHead!==parent.head||!id(destination.documentId)||!id(destination.epochId)||
    isRecipeDocumentId(destination.documentId)||isPolicyDocumentId(destination.documentId)||
    !Number.isSafeInteger(destination.generation)||destination.generation<=parent.generation||
    [...nodes.values()].some(node=>node.runtime.documentId===destination.documentId||node.epochId===destination.epochId)){
  throw Error('INVALID_DOCUMENT_SET');
 }
}

/** Project only the rebuilt draft. The current branch supplies authenticated
 * operation evidence and the source guard, never replacement cooking values. */
export async function prepareDraftRotationProjection({runtime,binding,destination,allocateSeed}){
 binding=structuredClone(binding);
 destination=structuredClone(destination);
 const {storage,LoroDoc,scope,authority}=runtime,{rootPin:pin,provider,installedSet}=authority;
 const savedDraft=must(await storage.readSelectedRetention(scope.scopeId,binding.draftId));
 const {guard,...checked}=await checkedDraftSource(runtime,binding);
 if(binding.suspectDevice===scope.authorDevice)throw Error('INVALID_DRAFT_SOURCE');
 const service=disclosureService({storage,scope:guard.expectedAuthority.scope,rootPin:pin,provider,deviceId:scope.authorDevice,installedSet});
 const context=await service.authority();
 if(!sameReportValue(context.resolved.expectedAuthority,guard.expectedAuthority))throw Error('STALE_SOURCE');
 const {nodes}=context.verified,parent=nodes.get(binding.sourceHead),state=context.current.state;
 if(!parent)throw Error('INVALID_DRAFT_SOURCE');
 checkDestination(destination,parent,nodes);
 const frozen=await selectedOperationReportService(runtime).reopen(binding.reportHash);
 if(!sameReportValue(guard,frozen.guard))throw Error('STALE_SOURCE');
 const manifest=frozen.report.payload.observation.manifest;
 const retained=new Map(checked.rows.filter(row=>row.status==='retained').map(row=>[row.effectId,row]));
 const sourceRows=new Map([guard.root,...guard.entries,...(guard.members??[])].filter(Boolean).map(row=>[row.documentId,row]));
 const byDocument=new Map(),omittedRecipeIds=new Set(),childRecipeIngredients=new Map();
 const usedPeers=new Set([...nodes.values()].flatMap(node=>Object.values(node.runtime.authorPeers))),usedSeeds=new Set();
 for(const item of state.events){
  const projected=item.admission?.manifest?.entries??item.rotation?.manifest?.entries??[];
  for(const entry of projected){usedSeeds.add(entry.seedId);usedPeers.add(entry.peerId);}
 }
 for(const entry of checked.documents){
  const draft=loadDoc(LoroDoc,entry.snapshot);
  const source=sourceRows.get(entry.documentId);
  if(!source&&entry.recipeId!==null)throw Error('INVALID_DRAFT_SOURCE');
  const live=loadDoc(LoroDoc,source?.bytes);
  for(const doc of [draft,live])for(const peer of doc.oplogVersion().toJSON().keys())usedPeers.add(peer);
  if(entry.seedId!==null)usedSeeds.add(entry.seedId);
  const sourceRuntime=entry.recipeId===null?runtime:await runtime.forRecipe(entry.recipeId);
  if(sourceRuntime.scope.documentId!==entry.documentId)throw Error('INVALID_DRAFT_SOURCE');

  const savedSeeds=new Map();
  for(const identity of entry.identities){
   const marker={version:3,seedId:entry.seedId,effectId:identity.effectId,commandId:identity.commandId};
   if(!identity.incomplete||!sameReportValue(draft.getMap('domain-effects').get(identity.effectId),marker)||
      !sameReportValue(live.getMap('domain-effects').get(identity.effectId),marker))throw Error('INVALID_SEED_PROOF');
   savedSeeds.set(identity.effectId,{seedId:entry.seedId,policies:identity.policyHashes,incomplete:true,sourceDependencies:[]});
  }
  const verify=createSourceVerifier({runtime:sourceRuntime,service,context,allowIncomplete:true,selectedDocument:live,selectedSeedEffects:savedSeeds});
  byDocument.set(entry.documentId,{draft,verify,scope:sourceRuntime.scope,revision:source?.revision??null});
  if(entry.recipeId!==null){
   const recipeId=entry.recipeId,recipe=draft.getMap(mapName('recipe',recipeId));
   if(!draft.getMap('recipe-index').get(recipeId)||recipe.get('removed')||recipe.get('removedAt')){
    omittedRecipeIds.add(recipeId);
    continue;
   }
   const members=Object.keys(draft.getMap(mapName('recipe-ingredient-index',recipeId)).toJSON());
   childRecipeIngredients.set(recipeId,new Set(members.filter(ingredientId=>{
    const member=draft.getMap(mapName('recipe-ingredient',JSON.stringify([recipeId,ingredientId])));
    return !member.get('removed')&&!member.get('removedAt');
   })));
  }
 }

 const verified=new Map(),visiting=new Set();
 async function prove(documentId,effectId){
  const key=JSON.stringify([documentId,effectId]);
  if(verified.has(key))return verified.get(key);
  if(visiting.has(key))throw Error('INVALID_SOURCE_PROOF');
  visiting.add(key);
  const source=byDocument.get(documentId);
  if(!source?.draft.getMap('domain-effects').get(effectId))throw Error('SOURCE_PROVENANCE_REQUIRED');
  const proof=await source.verify(effectId);
  if(!proof.seedId){
   const row=retained.get(effectId),marker=source.draft.getMap('domain-effects').get(effectId);
   if(row?.documentId!==documentId||row.objectId!==proof.objectId||marker.version!==2||
      !sameReportValue(marker.command,proof.command))throw Error('INVALID_SOURCE_PROOF');
   const claim=proof.command.data.recipeSource;
   for(const dep of proof.command.dependencyEffectIds){
    await prove(claim?.effectIds.includes(dep)?claim.documentId:documentId,dep);
   }
  }
  const result={policies:proof.policies,incomplete:true};
  visiting.delete(key);
  verified.set(key,result);
  return result;
 }

 const documents=[],removed=[];
 let size=0;
 for(const [index,entry] of checked.documents.entries()){
  const {recipeId,documentId}=entry;
  const observation=index===0?manifest.root:manifest.children[index-1];
  if(omittedRecipeIds.has(recipeId)){
   removed.push(await selectedSourceHash(provider,'removed-recipe-source-v1',observation));
   continue;
  }
  const {seedId,peerId}=await allocateSeed(documentId)??{};
  if(typeof seedId!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(seedId)||
     typeof peerId!=='string'||!/^[1-9][0-9]{0,19}$/.test(peerId)||BigInt(peerId)>18446744073709551615n||
     usedPeers.has(peerId)||usedSeeds.has(seedId))throw Error('INVALID_SEED');
  usedSeeds.add(seedId);
  usedPeers.add(peerId);
  const projected=projectCurrentSeed({LoroDoc,source:entry.snapshot,seedId,peerId,includeLocalMapping:true,
   schemaVersion:4,...(recipeId===null?{omittedRecipeIds,childRecipeIngredients}:{})});
  const {scope:sourceScope,revision}=byDocument.get(documentId);
  if(revision!==observation.revision)throw Error('INVALID_DRAFT_SOURCE');
  const {localMapping,...emptySeed}=projected;
  if(revision===null&&localMapping.length)throw Error('INVALID_DRAFT_SOURCE');
  const {seed,bundle,bundleHash}=revision===null?{seed:emptySeed,bundle:null,bundleHash:null}:
   await assemblePolicyProjection({scope:sourceScope,revision,projected,verify:effect=>prove(documentId,effect),
    service,context,provider,version:4});
  if(bundle)await verifyPolicyProjection({provider,pin,state,seed,bundle,expectedBundleHash:bundleHash,
   expectedSourceHead:binding.sourceHead,expectedSourceDocument:documentId,expectedSourceRevision:revision,
   LoroDoc,selectedRecipeId:recipeId??undefined,allowEmpty:true});
  else verifyCurrentSeed({LoroDoc,snapshot:seed.snapshot,seed,schemaVersion:4});
  size+=seed.snapshot.length+(bundle?authorityBytes(bundle).length:0);
  if(size>MAX_SELECTED_SET_BYTES)throw Error('TOO_LARGE');
  documents.push({recipeId,sourceDocumentId:documentId,sourceRevision:revision,sourceHash:observation.checkpointHash,
   seed,policyBundle:bundle,policyBundleHash:bundleHash,snapshotHash:await selectedSourceHash(provider,'projection-snapshot',hex(seed.snapshot))});
 }
 const final=await selectedOperationReportService(runtime).reopen(binding.reportHash);
 if(!sameReportValue(final.guard,guard)||
    !sameReportValue(savedDraft,must(await storage.readSelectedRetention(scope.scopeId,binding.draftId))))throw Error('STALE_SOURCE');
 must(await storage.checkSelectedHouseholdSources(guard));
 return {binding,destination,documents,removed:removed.sort(),source:guard,sourceManifest:manifest};
}
