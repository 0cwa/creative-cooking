import {normalizedFrontiers} from '../authority/policy-baseline.mjs';
import {recipeDocumentId} from '../domain/recipe-document.mjs';
import {bytes,shoppingRecipeSource} from '../domain/registry.mjs';
import {createSourceVerifier} from './source-proof.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sameCommand=(a,b)=>same(Array.from(bytes(a)),Array.from(bytes(b)));
const authorityIdentity=expected=>[expected.scope.kind,expected.scope.id,expected.record.revision,
  expected.record.acceptedParent,expected.record.authorizationSnapshot];

/** A signed shopping claim can resolve only its selected recipe child. */
export function createShoppingRecipeSourceVerifier({runtime,service,context,local=false}) {
  const catalogs=new Map();
  return async (command,expectedAuthority=context.resolved.expectedAuthority)=>{
    const {recipeSource:claim,recipeId}=command.data;
    if (!claim) return undefined;
    if (runtime.recipeId!==null || runtime.scope.documentId!==context.resolved.scope.documentId ||
        !same(authorityIdentity(expectedAuthority),authorityIdentity(context.resolved.expectedAuthority))) {
      throw Error('INVALID_AUTHORITY');
    }
    const documentId=await recipeDocumentId(runtime.scope,runtime.authority.rootPin,runtime.authority.provider,recipeId);
    const peers=new Set(Object.values(runtime.scope.authorPeers));
    if (claim.documentId!==documentId || claim.frontiers.some(point=>!peers.has(point.peer))) {
      throw Error('INVALID_RECIPE_SOURCE');
    }
    if (!catalogs.has(recipeId)) {
      const {openSelectedRecipeCatalog}=await import('../app/selected-recipe-catalog.mjs');
      const catalog=await openSelectedRecipeCatalog(runtime,recipeId);
      if (!same(authorityIdentity(catalog.expectedAuthority),authorityIdentity(expectedAuthority))) throw Error('CONFLICT');
      const child=catalog.children.get(recipeId);
      if (!child) throw Error('MISSING_DEPENDENCY');
      const sourceRuntime=await runtime.forRecipe(recipeId);
      const verify=createSourceVerifier({runtime:sourceRuntime,service,context,allowIncomplete:true,selectedDocument:child.doc});
      catalogs.set(recipeId,{catalog,child,verify});
    }
    const {catalog,child,verify}=catalogs.get(recipeId);
    if (local && !same(normalizedFrontiers(child.doc),claim.frontiers)) throw Error('REBASE_REQUIRED');
    const version=child.doc.oplogVersion().toJSON();
    if (claim.frontiers.some(({peer,counter})=>(version.get(peer)??0)<=counter)) throw Error('MISSING_DEPENDENCY');
    const observed=child.doc.forkAt(claim.frontiers);
    if (!same(normalizedFrontiers(observed),claim.frontiers)) throw Error('INVALID_RECIPE_SOURCE');
    const source=shoppingRecipeSource({documentId,doc:observed},command.data);
    if (!same(source.effectIds,claim.effectIds)) throw Error('INVALID_RECIPE_SOURCE');

    // Each frontier must terminate a complete signed command. A partial
    // ingredient update could otherwise expose a value before its field head.
    const tips=new Map(claim.frontiers.map(point=>[point.peer,point.counter]));
    const terminalEffects=new Map();
    for (const change of observed.exportJsonUpdates(undefined,undefined,false).changes) {
      const peer=change.id.split('@')[1],counter=tips.get(peer);
      const op=change.ops.find(op=>op.counter===counter && op.container==='cid:root-domain-effects:Map');
      if (op) terminalEffects.set(peer,op.content.key);
    }
    if (terminalEffects.size!==tips.size) throw Error('INVALID_RECIPE_SOURCE');
    const sources=new Map();
    const markers=observed.getMap('domain-effects');
    for (const effectId of new Set([...source.effectIds,...terminalEffects.values()])) {
      const signed=await verify(effectId),marker=markers.get(effectId);
      if (marker?.version!==2 || !sameCommand(marker.command,signed.command)) throw Error('INVALID_RECIPE_SOURCE');
      sources.set(effectId,signed);
    }
    for (const [peer,effectId] of terminalEffects) {
      const end=sources.get(effectId).end;
      if (end.peer!==peer || end.counter!==tips.get(peer)) throw Error('INVALID_RECIPE_SOURCE');
    }
    const receipt={consumerEffectId:command.effectId,binding:catalog.binding,recipeId,documentId,
      revision:child.revision,creationObjectId:child.creationObjectId,
      effects:[...sources].map(([effectId,signed])=>({effectId,objectId:signed.objectId}))};
    return {source,receipt,sources:new Map(source.effectIds.map(id=>[id,sources.get(id)]))};
  };
}
