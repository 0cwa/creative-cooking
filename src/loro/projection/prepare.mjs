// Prepare only: no durable commit, publication, authority transition, or release.
// Caller must validate source authority, admission, delegation, recipient keys and
// atomic publication separately. This experimental narrow projection supports only
// the current runtime's recipe title and purchase values.
const id=x=>typeof x==='string' && x.length>0 && new TextEncoder().encode(x).length<=256;
const exact=(x,ks)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).length===ks.length && ks.every(k=>Object.hasOwn(x,k));
export async function prepareCurrentCooking({LoroDoc,provider,source,context,recipients}) {
 source=structuredClone(source); context=structuredClone(context); recipients=structuredClone(recipients);
 if (!exact(source,['recipeTitle','purchases']) || typeof source.recipeTitle!=='string' || source.recipeTitle.length>65536 || !Array.isArray(source.purchases) || source.purchases.length>10000 || !source.purchases.every(p=>exact(p,['effectId','value']) && id(p.effectId) && typeof p.value==='string' && p.value.length<=65536) || new Set(source.purchases.map(p=>p.effectId)).size!==source.purchases.length) throw Error('MALFORMED');
 if (!exact(context,['householdId','parentHead','oldDocumentId','oldGeneration','oldEpochId','newDocumentId','newGeneration','newEpochId']) || ![context.householdId,context.parentHead,context.oldDocumentId,context.oldEpochId,context.newDocumentId,context.newEpochId].every(id) || !Number.isSafeInteger(context.oldGeneration) || !Number.isSafeInteger(context.newGeneration) || context.oldGeneration<0 || context.newGeneration<=context.oldGeneration || context.oldDocumentId===context.newDocumentId || context.oldEpochId===context.newEpochId) throw Error('MALFORMED');
 if (!Array.isArray(recipients) || !recipients.length || recipients.length>128 || !recipients.every(id) || new Set(recipients).size!==recipients.length) throw Error('MALFORMED');
 const doc=new LoroDoc(); doc.getMap('recipe').set('title',source.recipeTitle);
 for(const p of source.purchases) doc.getMap('purchases').set(p.effectId,p.value);
 const snapshot=doc.export({mode:'snapshot'});
 // Provider must create an independently random key and persist it securely before
 // publication; keyRef is opaque and every returned package is recipient-encrypted.
 const generated=await provider.generateKey();
 if (!generated || !id(generated.keyRef)) throw Error('INVALID_KEY');
 const packages=[];
 for(const recipient of recipients) {
  const value=await provider.wrapKey(generated.keyRef,recipient,structuredClone(context));
  if (!(value instanceof Uint8Array) || !value.length) throw Error('INVALID_KEY_PACKAGE');
  packages.push({recipient,bytes:new Uint8Array(value)});
 }
 return {context,snapshot:new Uint8Array(snapshot),keyRef:generated.keyRef,packages};
}
/** Never import old operations into a new generation; retain for semantic review. */
export function classifyPendingEdit(edit,current) {
 if (!exact(edit,['documentId','generation','epochId']) || !exact(current,['documentId','generation','epochId']) || ![edit.documentId,edit.epochId,current.documentId,current.epochId].every(id) || !Number.isSafeInteger(edit.generation) || !Number.isSafeInteger(current.generation) || edit.generation<0 || current.generation<0) throw Error('MALFORMED');
 return edit.documentId===current.documentId && edit.generation===current.generation && edit.epochId===current.epochId ? 'CURRENT_CONTEXT' : 'PRESERVE_FOR_SEMANTIC_REBASE_OR_REVIEW';
}
