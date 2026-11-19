import {policyBaseline} from '../authority/policy-baseline.mjs';
import {MAX_SELECTED_CHILDREN,MAX_SELECTED_SET_BYTES} from '../contracts/runtime-storage.ts';
import {observeSelectedSourceSet,selectedSourceHash,verifySelectedSourceSet} from '../projection/selected-sources.mjs';
import {exact,inspectOwnDeviceSnapshot,must,ownDeviceCopyHash,verifyOwnDeviceDocumentCopy} from './household-own-device.mjs';

const hex=bytes=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
const validPeerId=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value)&&BigInt(value)<=18446744073709551615n;
const copyFields=['recipeId','documentId','revision','baseline','copy'];
const payloadFields=['snapshot','seed','seedSnapshot','sources','policies'];
const commitment=(provider,sodium,set)=>selectedSourceHash(provider,'household-own-device-copy-set-v1',{
 version:set.version,peerId:set.peerId,observation:set.observation,
 documents:set.documents.map(({copy,...entry})=>({...entry,hash:ownDeviceCopyHash(sodium,copy)})),
});

/** Capture household-only history at the selected head. The caller must carry
 * the guard into the transaction that publishes the signed copy. */
export async function captureOwnDeviceCopySet({runtime,service,sodium,peerId,seedId}) {
 if(!validPeerId(peerId)||Object.values(runtime.scope.authorPeers).includes(peerId))throw Error('INVALID_COPY');
 const {provider}=runtime.authority,{storage,LoroDoc}=runtime;
 const {signed:observation,sources,guard}=await observeSelectedSourceSet(runtime);
 const {expectedAuthority}=guard;
 const disclosure=await service.authority();
 const documents=[];
 let total=0;
 for(const source of sources){
  const {recipeId,scope:{documentId}}=source.runtime;
  const retained=must(await storage.readProjectionSeed(expectedAuthority,documentId));
  const snapshot=source.bytes??new LoroDoc().export({mode:'snapshot'});
  const seedSnapshot=retained?.snapshot??null;
  total+=snapshot.length+(seedSnapshot?.length??0);
  if(total>MAX_SELECTED_SET_BYTES)throw Error('TOO_LARGE');
  const seed=retained?.seed??{seedId,identities:[]};
  const {doc,identities}=inspectOwnDeviceSnapshot({LoroDoc,snapshot,peerId,seed,seedSnapshot});
  const policies=new Map();
  const rows=must(await storage.readOwnDeviceSourcePolicies(expectedAuthority,documentId,identities.map(row=>row.effectId)));
  for(const hash of new Set(rows.flatMap(row=>row.policyHashes))){
   for(let next=hash;next&&!policies.has(next);){
    const policy=await service.validateStored(next,disclosure);
    policies.set(next,policy);
    if(policies.size>64)throw Error('TOO_LARGE');
    next=policy.policy.predecessor;
   }
  }
  documents.push({recipeId,documentId,revision:source.revision,baseline:await policyBaseline(doc,provider),
   copy:{snapshot,seed,seedSnapshot,sources:rows,policies:[...policies.values()].sort((a,b)=>a.policyHash<b.policyHash?-1:1)}});
 }
 const set={version:1,peerId,observation,documents};
 const copyHash=await commitment(provider,sodium,set);
 must(await storage.checkSelectedHouseholdSources(guard));
 return {set,copyHash,guard};
}

/** Verify an encrypted copy against an independently retained parent and the
 * copy commitment and sponsor from the signed own-device event. This verifies
 * policy attestations; it confers no independent disclosure provenance. */
export async function verifyOwnDeviceCopySet({storage,scope,pin,provider,sodium,LoroDoc,set,copyHash,authorDevice,peerId}) {
 scope=structuredClone(scope);
 if(!validPeerId(peerId)||!exact(set,['version','peerId','observation','documents'])||set.version!==1||set.peerId!==peerId||
    !Array.isArray(set.documents)||!set.documents.length||set.documents.length>MAX_SELECTED_CHILDREN+1)throw Error('INVALID_COPY');
 let total=0;
 for(const entry of set.documents){
  if(!exact(entry,copyFields)||!exact(entry.copy,payloadFields)||
     !(entry.copy.snapshot instanceof Uint8Array)||
     !(entry.copy.seedSnapshot===null||entry.copy.seedSnapshot instanceof Uint8Array))throw Error('INVALID_COPY');
  total+=entry.copy.snapshot.length+(entry.copy.seedSnapshot?.length??0);
  if(total>MAX_SELECTED_SET_BYTES)throw Error('TOO_LARGE');
 }
 set=structuredClone(set);
 const {manifest,state,selected}=await verifySelectedSourceSet({storage,scope,pin,provider,signed:set.observation});
 if(set.observation.deviceId!==authorDevice||Object.values(selected.runtime.authorPeers).includes(peerId)||
    set.documents.length!==manifest.children.length+1)throw Error('INVALID_COPY');
 const sources=[{...manifest.root,recipeId:null},...manifest.children];
 const result=[];
 const effects=new Set(),commands=new Set();
 for(const [index,{recipeId,documentId,revision,baseline,copy}] of set.documents.entries()){
  const expected=sources[index];
  if(documentId!==expected.documentId||recipeId!==expected.recipeId||revision!==expected.revision||
     (expected.checkpointHash===null
       ?baseline?.frontiers?.length!==0||copy.seedSnapshot!==null
       :await selectedSourceHash(provider,'projection-source-snapshot',hex(copy.snapshot))!==expected.checkpointHash))throw Error('INVALID_COPY');
  const identities=await verifyOwnDeviceDocumentCopy({sodium,provider,LoroDoc,copy,pin,parentState:state,
   authorDevice,householdId:scope.id,peerId,baseline});
  for(const {effectId,commandId} of identities){
   if(effects.has(effectId)||commands.has(commandId))throw Error('INVALID_COPY');
   effects.add(effectId);
   commands.add(commandId);
  }
  result.push({recipeId,documentId,revision,baseline,copy,identities});
 }
 if(await commitment(provider,sodium,set)!==copyHash)throw Error('INVALID_COPY');
 return result;
}
