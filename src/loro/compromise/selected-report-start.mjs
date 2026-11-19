import {authorityBytes,matchesInstalledSetAuthority} from '../authority/chain.mjs';
import {verifySelectedSourceSet} from '../projection/selected-sources.mjs';
import {readInstalledHouseholdDocumentSet} from '../pairing/household-document-set.mjs';
import {canonicalReportBytes} from './report.mjs';
import {REVIEW_LIMITS} from './review.mjs';
import {selectedOperationReportService} from './selected-report-service.mjs';

const same=(a,b)=>{
 const left=authorityBytes(a),right=authorityBytes(b);
 return left.length===right.length&&left.every((byte,i)=>byte===right[i]);
};

/** Resolve only independently verified starting history for the frozen report.
 * The observed cooking snapshots bind the source, but never supply the start. */
export async function resolveSelectedReportStart(runtime,reportHash) {
 const {report,evidence,guard}=await selectedOperationReportService(runtime).reopen(reportHash);
 const {storage,LoroDoc,scope,authority}=runtime, {provider,rootPin:pin,installedSet}=authority;
 const expected=guard.expectedAuthority,household=expected.scope;
 const {manifest,record,state}=await verifySelectedSourceSet({storage,scope:household,pin,provider,signed:report.payload.observation});
 if(!same(expected.record,{revision:record.revision,acceptedParent:record.acceptedParent,authorizationSnapshot:record.authorizationSnapshot}))
  throw Error('STALE_AUTHORITY');

 let installed=null;
 if(manifest.version===2){
  const event=state.events.find(item=>item.admission?.manifest?.version===5 &&
    item.admission.grant.admissionEventHash===manifest.parentHead);
  if(!event || !installedSet || installedSet.paired || installedSet.operationId!==event.admission.operationId)
   throw Error('CHECKPOINT_UNAVAILABLE');
  installed=await readInstalledHouseholdDocumentSet({storage,scope:household,pin,provider,LoroDoc,
    sodium:installedSet.sodium,operationId:installedSet.operationId});
  if(!matchesInstalledSetAuthority(record,state,installed.publication.nextAuthority) || !same(event,installed.item) ||
    installed.publication.localKey.record.identity.deviceId!==scope.authorDevice)
   throw Error('CHECKPOINT_UNAVAILABLE');
 }else if(manifest.version!==1 || manifest.parentHead!==pin || installedSet)throw Error('CHECKPOINT_UNAVAILABLE');

 const retained=new Map((installed?.documents??[]).map(document=>[document.documentId,document]));
 const seedEntries=new Map((installed?.item.admission.manifest.entries??[]).map(entry=>[entry.documentId,entry]));
 let total=canonicalReportBytes(report).length+evidence.reduce((n,row)=>n+row.bytes.length,0);
 const documents=[];
 for(const claim of [{recipeId:null,...manifest.root},...manifest.children]){
  const {recipeId,documentId}=claim;
  const needsSeed=!!installed&&(recipeId===null||claim.creationObjectId===null);
  if(!needsSeed&&recipeId!==null&&(!claim.creationObjectId||!claim.creationEffectId))throw Error('CHECKPOINT_UNAVAILABLE');
  const document=retained.get(documentId),entry=seedEntries.get(documentId);
  if(needsSeed!==!!document||needsSeed!==!!entry||(entry&&entry.recipeId!==recipeId))throw Error('CHECKPOINT_UNAVAILABLE');
  let snapshot=new Uint8Array(),seedId=null,identities=[],policies=[];
  if(document){
   snapshot=document.seed.snapshot;
   seedId=document.seed.seedId;
   const restrictions=new Map((document.policyBundle?.entries??[]).map(row=>[row.effectId,row.policyHashes]));
   identities=document.seed.identities.map(identity=>{
    const policyHashes=restrictions.get(identity.effectId);
    if(!policyHashes)throw Error('CHECKPOINT_UNAVAILABLE');
    return {...identity,policyHashes,incomplete:true};
   });
   policies=document.policyBundle?.policies??[];
  }
  total+=snapshot.length+canonicalReportBytes({identities,policies}).length;
  if(snapshot.length>REVIEW_LIMITS.objectBytes||total>REVIEW_LIMITS.bytes)throw Error('TOO_LARGE');
  documents.push({recipeId,documentId,snapshot,seedId,identities,policies});
  retained.delete(documentId);
 }
 if(retained.size)throw Error('CHECKPOINT_UNAVAILABLE');
 const checked=await storage.checkSelectedHouseholdSources(guard);
 if(!checked.ok)throw Error(checked.error.code);
 return structuredClone({reportHash,documents,guard});
}
