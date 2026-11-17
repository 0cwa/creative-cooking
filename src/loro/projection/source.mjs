// Verify the exact durable source and restrict the fresh snapshot to the narrow
// current recipe-title/purchase projection supported by this candidate runtime.
import {LoroDoc} from 'loro-crdt';
import {domain} from '../authority/validator.mjs';
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const canonical=v=>Array.isArray(v)?v.map(canonical):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export async function checkProjectionSource(storage,expectedAuthority,manifest,grant,snapshot,provider) {
 try {
  const result=await storage.reopenBranchDocument(expectedAuthority,manifest.sourceDocument);
  if(!result.ok || !result.value) throw Error('SOURCE_UNAVAILABLE');
  const source=result.value, digest=await provider.hash(domain('projection-source-snapshot',hex(source.bytes)));
  if(!(digest instanceof Uint8Array) || digest.length!==32 || hex(digest)!==manifest.sourceCheckpointHash) throw Error('SOURCE_MISMATCH');
  const old=new LoroDoc(), fresh=new LoroDoc(); old.import(source.bytes); fresh.import(snapshot);
  const title=old.getMap('recipe').get('title'), purchases=old.getMap('purchases').toJSON();
  if(typeof title!=='string' || !grant.contentClasses.includes('recipe') || !grant.contentClasses.includes('shopping') || !purchases || Array.isArray(purchases) || Object.values(purchases).some(v=>typeof v!=='string')) throw Error('SOURCE_MISMATCH');
  const expected={recipe:{title},purchases};
  if(!eq(canonical(fresh.toJSON()),canonical(expected))) throw Error('PROJECTION_MISMATCH');
  const updates=fresh.exportJsonUpdates(undefined,undefined,false);
  const ops=updates.changes.flatMap(c=>c.ops);
  const expectedOps=[{container:'cid:root-recipe:Map',key:'title',value:title},...Object.entries(purchases).map(([key,value])=>({container:'cid:root-purchases:Map',key,value}))];
  const actual=ops.map(op=>({container:op.container,key:op.content?.key,value:op.content?.value}));
  const sort=a=>a.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if(ops.some(op=>op.content?.type!=='insert') || !eq(sort(actual),sort(expectedOps))) throw Error('PROJECTION_MISMATCH');
  return {status:'verified',sourceDocument:{documentId:manifest.sourceDocument,revision:source.revision}};
 } catch(e) {throw Error(e instanceof Error ? e.message : 'INVALID_PROOF')}
}
