import {candidateCodec} from '../crypto/candidate.mjs';
import {localProvider} from './local-provider.mjs';
import {policyBaseline,normalizedFrontiers} from '../authority/policy-baseline.mjs';
import * as registry from '../domain/registry.mjs';
import {policyId} from '../authority/chain.mjs';

const canon=x=>x instanceof Uint8Array?Array.from(x):Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
const same=(a,b)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
const must=r=>{if(!r.ok)throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value};

// Replay only the local recipe-field route supported by activatedPolicyEdit.
export async function verifyActivatedHistory({storage,LoroDoc,provider,keys,sodium,scope,deviceId,targetHead,receipt,staged,documents,parent,item,provenance}) {
 const expectedAuthority={version:2,scope,record:{revision:receipt.next.revision,acceptedParent:targetHead,authorizationSnapshot:receipt.next.authorizationSnapshot}};
 const refs=Object.fromEntries(parent.devices.filter(d=>d.active).map(d=>[d.deviceId,d.signingKeyRef]));
 const policyHash=await policyId(provider,item.event.nextPolicy);
 const operations=must(await storage.listBranchLocalOperations(expectedAuthority));
 const commits=[];
 for(const op of operations){const saved=must(await storage.getLocalOperation(scope.id,op.operationId));if(!saved)throw Error('INVALID_ACTIVATED_HISTORY');commits.push(saved)}
 const histories=[];
 for(const [i,stored] of documents.entries()) {
  const row=staged.mapping[i], target=receipt.targets[i], doc=new LoroDoc();
  if(doc.import(row.baseline).pending?.size)throw Error('INVALID_ACTIVATED_HISTORY');
  const entries=commits.filter(({commit})=>commit.documents.some(d=>d.documentId===stored.documentId));
  entries.sort((a,b)=>a.commit.documents[0].expectedRevision-b.commit.documents[0].expectedRevision);
  if(stored.revision!==entries.length || (row.recipeId===null && entries.length))throw Error('INVALID_ACTIVATED_HISTORY');
  const codec=candidateCodec(localProvider(sodium,keys,{signing:{},content:(epoch,fn)=>{if(epoch!==parent.epochId)throw Error('INVALID_ACTIVATED_HISTORY');return keys.use(target.operationId,target.identity,fn)}}));
  let previousSequence=-1;
  for(const [index,{commit,outcome}] of entries.entries()) {
   if(commit.documents.length!==1 || commit.commands.length!==1 || commit.outbound.length!==1 || commit.documents[0].expectedRevision!==index || !same(commit.expectedAuthority,expectedAuthority) || !same(outcome.revisions,[{documentId:stored.documentId,revision:index+1}]))throw Error('INVALID_ACTIVATED_HISTORY');
   const outbound=commit.outbound[0], opened=await codec.openContent(outbound.object.bytes,refs), h=opened.header;
   if(opened.object.id!==outbound.object.id || outbound.branchHead!==targetHead || outbound.epochId!==parent.epochId || h.version!==3 || h.scopeId!==scope.id || h.documentId!==stored.documentId || h.documentGeneration!==parent.generation || h.branchHead!==targetHead || h.epochId!==parent.epochId || h.suiteId!=='candidate-ed25519-xchacha20-sealedbox-v1' || !same(h.policyHashes,[policyHash]) || h.authorDevice!==deviceId || !refs[deviceId] || h.payloadKind!=='loro-update-v1' || h.disclosureIncomplete!==true || h.disclosurePolicyHash!==null)throw Error('INVALID_ACTIVATED_HISTORY');
   let payload;try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(opened.value))}catch{throw Error('INVALID_ACTIVATED_HISTORY')}
   if(!same(opened.value,new TextEncoder().encode(JSON.stringify(payload))) || !payload || Object.keys(payload).sort().join(',')!=='command,update,version' || payload.version!==1 || !Array.isArray(payload.update) || !payload.update.every(x=>Number.isInteger(x)&&x>=0&&x<=255))throw Error('INVALID_ACTIVATED_HISTORY');
   const command=registry.validate(payload.command), c=commit.commands[0];
   const sources=provenance?.[i]?.sources, policies=new Set();
   for(const dependency of command.dependencyEffectIds){const source=sources?.find(value=>value.effectId===dependency);if(!source || source.incomplete!==true)throw Error('INVALID_ACTIVATED_HISTORY');for(const hash of source.policyHashes)policies.add(hash)}
   if(!same(h.disclosurePolicyHashes,[...policies].sort()) || h.deviceSequence<=previousSequence)throw Error('INVALID_ACTIVATED_HISTORY');
   previousSequence=h.deviceSequence;
   if(command.kind!=='recipe-field' || command.data.recipeId!==row.recipeId || (command.data.author!==undefined && command.data.author!==deviceId) || !same(h.semanticEffectIds,[command.effectId]) || !same(h.sourceEffectIds,[...command.dependencyEffectIds].sort()) || c.documentId!==stored.documentId || c.commandId!==command.commandId || c.effectId!==command.effectId || c.kind!==command.kind || !same(c.payload,registry.bytes(command)) || !same(c.dependencyEffectIds,command.dependencyEffectIds))throw Error('INVALID_ACTIVATED_HISTORY');
   const predecessors=normalizedFrontiers(doc).map(({peer,counter})=>`${peer}:${counter}`).sort();
   if(!same(predecessors,h.predecessorRefs))throw Error('INVALID_ACTIVATED_HISTORY');
   registry.checkPreconditions(doc,command);const start=doc.oplogVersion();
   if(doc.import(Uint8Array.from(payload.update)).pending?.size)throw Error('INVALID_ACTIVATED_HISTORY');
   const changes=doc.exportJsonUpdates(start,undefined,false).changes;
   if(changes.length!==1 || String(changes[0].id).split('@')[1]!==parent.runtime.authorPeers[deviceId])throw Error('INVALID_ACTIVATED_HISTORY');
   registry.validateOperations(command,changes);
   const committed=new LoroDoc();if(committed.import(commit.documents[0].bytes).pending?.size || !same(await policyBaseline(committed,provider),await policyBaseline(doc,provider)))throw Error('INVALID_ACTIVATED_HISTORY');
  }
  const actual=new LoroDoc();if(actual.import(stored.bytes).pending?.size)throw Error('INVALID_ACTIVATED_HISTORY');
  const history=await policyBaseline(doc,provider);
  if(!same(history,await policyBaseline(actual,provider)))throw Error('INVALID_ACTIVATED_HISTORY');
  histories.push({documentId:stored.documentId,revision:stored.revision,history});
 }
 return histories;
}
