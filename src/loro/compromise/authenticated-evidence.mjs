import {validate,bytes} from '../domain/registry.mjs';
import {assertCommandScope} from '../domain/personal-codec.mjs';
import {REVIEW_LIMITS} from './review.mjs';

const eq=(a,b)=>{const left=bytes(a),right=bytes(b);return left.length===right.length&&left.every((value,i)=>value===right[i]);};
const dense=a=>Array.isArray(a)&&Array.from({length:a.length},(_,i)=>Object.hasOwn(a,i)).every(Boolean);

// Authenticate the original envelope and its declared operation. Proving the
// operation's full causal ancestry requires reconstruction from a trusted base.
export async function authenticateEvidence(runtime,kind,a,o) {
 const opened=await runtime.codec.openContent(o.bytes,a.signingKeyRefs),h=opened.header,s=a.scope;
 if(opened.object.id!==o.objectId||h.scopeId!==s.scopeId||h.documentId!==s.documentId||h.documentGeneration!==s.documentGeneration||h.branchHead!==s.branchHead||h.epochId!==s.epochId||h.suiteId!==s.suiteId||!eq(h.policyHashes,s.policyHashes)||!s.acceptedAuthors.includes(h.authorDevice)||h.payloadKind!=='loro-update-v1'||h.semanticEffectIds.length!==1)throw Error('INVALID_AUTHORITY');
 let p;try{p=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(opened.value))}catch{throw Error('MALFORMED_UPDATE')}
 if(!p||Object.keys(p).sort().join(',')!=='command,update,version'||p.version!==1||!dense(p.update)||!p.update.every(x=>Number.isInteger(x)&&x>=0&&x<=255))throw Error('MALFORMED_UPDATE');
 const command=validate(p.command);assertCommandScope(command.kind,kind);if(command.dependencyEffectIds.length>REVIEW_LIMITS.dependencies||command.effectId!==h.semanticEffectIds[0]||(command.data.author!==undefined&&command.data.author!==h.authorDevice))throw Error('MALFORMED_UPDATE');
 if(['shopping-item-create','shopping-item-field','shopping-list-field'].includes(command.kind)&&h.version!==4)throw Error('UNSUPPORTED_VERSION');
 const update=Uint8Array.from(p.update),meta=runtime.inspectUpdate(update);if(meta.peer!==s.authorPeers[h.authorDevice]||!eq(meta.predecessors,h.predecessorRefs))throw Error('MALFORMED_UPDATE');
 if(h.version>=2&&!eq([...command.dependencyEffectIds].sort(),h.sourceEffectIds))throw Error('MALFORMED_UPDATE');
 const vectors=runtime.decodeImportBlobMeta(update,true);
 const startCounter=vectors.partialStartVersionVector.toJSON().get(meta.peer)??0;
 const endCounter=vectors.partialEndVersionVector.toJSON().get(meta.peer);
 return {sourceId:o.sourceId,objectId:o.objectId,authorDevice:h.authorDevice,sourceDocumentId:h.documentId,sourceGeneration:h.documentGeneration,sourceHead:h.branchHead,command,update,meta,startCounter,endCounter,disclosurePolicyHashes:h.disclosurePolicyHashes,disclosureIncomplete:h.disclosureIncomplete};
}
