import {policyBaseline,verifyRetainedPolicyBaseline} from './policy-baseline.mjs';
import {observeSelectedSourceSet,selectedSourceHash,verifySelectedSourceSet} from '../projection/selected-sources.mjs';
import {MAX_SELECTED_CHILDREN,MAX_SELECTED_SOURCE_BYTES,MAX_SELECTED_SET_BYTES} from '../contracts/runtime-storage.ts';
import {domain} from './validator.mjs';

const exact=(value,fields)=>value && typeof value==='object' && !Array.isArray(value) &&
  Object.keys(value).length===fields.length && fields.every(field=>Object.hasOwn(value,field));
const hex=bytes=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');

// The bounded checkout can return only to ordinary source histories.
export const unsupportedPolicySource=state=>state.events.some(item=>item.admission ||
  item.event?.version===6 || (item.event?.version===5 && item.event?.kind==='pairOwnDevice'));

/** Capture a signed baseline bound to the independently signed catalog and pin.
 * The caller must still use guard in the atomic publication transaction. */
export async function observePolicyDocumentSet(runtime) {
  const {signed:observation,sources,guard}=await observeSelectedSourceSet(runtime);
  const documents=[];
  for(const source of sources) documents.push({recipeId:source.runtime.recipeId??null,
    documentId:source.runtime.scope.documentId,baseline:await policyBaseline(source.doc,runtime.authority.provider)});
  const body={version:1,observation,documents};
  const deviceId=observation.deviceId;
  const {signingKeyRefs}=await runtime.authorization();
  const signature=hex(await runtime.authority.provider.sign(signingKeyRefs[deviceId],domain('policy-document-set-v1',{body,deviceId})));
  const checked=await runtime.storage.checkSelectedHouseholdSources(guard);
  if(!checked.ok) throw Error(checked.error.code);
  return {signed:{body,deviceId,signature},sources,guard};
}

/** Verify against the pinned authority and exact retained publisher snapshots.
 * Documents must be in root-first catalog order; no checkout is performed. */
export async function verifyPolicyDocumentSet({storage,scope,pin,provider,LoroDoc,signed,retained}) {
  signed=structuredClone(signed);
  if(!exact(signed,['body','deviceId','signature']) || !exact(signed.body,['version','observation','documents']) ||
    signed.body.version!==1 || signed.deviceId!==signed.body.observation?.deviceId ||
    typeof signed.signature!=='string' || !/^[a-f0-9]{128}$/.test(signed.signature)) throw Error('INVALID_POLICY_DOCUMENT_SET');
  const verified=await verifySelectedSourceSet({storage,scope,pin,provider,signed:signed.body.observation});
  const author=verified.selected.devices.find(device=>device.active && device.deviceId===signed.deviceId);
  if(!author || !await provider.verify(author.signingKeyRef,domain('policy-document-set-v1',
    {body:signed.body,deviceId:signed.deviceId}),Uint8Array.from(signed.signature.match(/../g),pair=>parseInt(pair,16))))
    throw Error('INVALID_POLICY_DOCUMENT_SIGNATURE');
  const expected=[{recipeId:null,...verified.manifest.root},...verified.manifest.children];
  const documents=signed.body.documents;
  if(!Array.isArray(documents) || !Array.isArray(retained) || documents.length!==expected.length ||
    retained.length!==expected.length || documents.length>MAX_SELECTED_CHILDREN+1) throw Error('INVALID_POLICY_DOCUMENT_SET');
  let total=0;
  for(let i=0;i<expected.length;i++) {
    const entry=documents[i], source=retained[i], claim=expected[i];
    if(!exact(entry,['recipeId','documentId','baseline']) || entry.recipeId!==claim.recipeId || entry.documentId!==claim.documentId ||
      !exact(entry.baseline,['frontiers','historyHash']) || !Array.isArray(entry.baseline.frontiers) ||
      !/^[a-f0-9]{64}$/.test(entry.baseline.historyHash) || !source || source.documentId!==claim.documentId ||
      source.revision!==claim.revision || !(source.bytes instanceof Uint8Array) || source.bytes.length>MAX_SELECTED_SOURCE_BYTES)
      throw Error('INVALID_POLICY_DOCUMENT_SET');
    total+=source.bytes.length;
    if(total>MAX_SELECTED_SET_BYTES) throw Error('INVALID_POLICY_DOCUMENT_SET');
    if(claim.checkpointHash===null ? source.bytes.length!==0 :
      await selectedSourceHash(provider,'projection-source-snapshot',hex(source.bytes))!==claim.checkpointHash)
      throw Error('INVALID_POLICY_DOCUMENT_SET');
    if(claim.checkpointHash===null) {
      const empty=await policyBaseline(new LoroDoc(),provider);
      if(JSON.stringify(empty)!==JSON.stringify(entry.baseline)) throw Error('POLICY_BASELINE_UNAVAILABLE');
    } else await verifyRetainedPolicyBaseline(LoroDoc,{bytes:source.bytes,revision:0},entry.baseline,provider);
  }
  return verified;
}

/** Authenticate the complete set before deriving or matching the compact event subject. */
export async function policyDocumentSetSubject(options) {
  const signed=structuredClone(options.signed);
  await verifyPolicyDocumentSet({...options,signed});
  return {baseline:structuredClone(signed.body.documents[0].baseline),
    setHash:await selectedSourceHash(options.provider,'policy-document-set-subject-v1',signed),
    documentCount:signed.body.documents.length};
}

export async function matchPolicyDocumentSetEvent(options,event) {
  event=structuredClone(event);
  const signed=structuredClone(options.signed);
  const subject=await policyDocumentSetSubject({...options,signed});
  const manifest=signed.body.observation.manifest;
  if(event?.version!==6 || event.kind!=='changePolicy' || event.authorDeviceId!==signed.deviceId ||
    event.householdId!==manifest.householdId || event.parentHead!==manifest.parentHead ||
    event.epochId!==manifest.epochId || event.generation!==manifest.generation ||
    hex(domain('policy-document-set-subject-comparison',event.subject))!==hex(domain('policy-document-set-subject-comparison',subject)))
    throw Error('POLICY_DOCUMENT_SET_EVENT_MISMATCH');
  return subject;
}
