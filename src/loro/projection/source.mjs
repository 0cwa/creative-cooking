// Verify the exact durable source and restrict the fresh snapshot to the narrow
// current recipe-title/purchase projection supported by this candidate runtime.
import {LoroDoc} from 'loro-crdt';
import {domain} from '../authority/validator.mjs';
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const canonical=v=>Array.isArray(v)?v.map(canonical):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export async function checkProjectionSource(storage,expectedAuthority,manifest,grant,snapshot,provider,sourceRuntime,policyBundle,disclosureService) {
 try {
  if([2,3,4].includes(manifest.version)&&!policyBundle)throw Error('PROVENANCE_REQUIRED');if([2,3,4].includes(manifest.version)&&policyBundle.version!==manifest.version)throw Error('PROJECTION_MISMATCH');
  const result=await storage.reopenBranchDocument(expectedAuthority,manifest.sourceDocument);
  if(!result.ok || !result.value) throw Error('SOURCE_UNAVAILABLE');
  const source=result.value, digest=await provider.hash(domain('projection-source-snapshot',hex(source.bytes)));
  if(!(digest instanceof Uint8Array) || digest.length!==32 || hex(digest)!==manifest.sourceCheckpointHash) throw Error('SOURCE_MISMATCH');
  const old=new LoroDoc(), fresh=new LoroDoc(); old.import(source.bytes); fresh.import(snapshot);
  if(manifest.schemaVersion.startsWith('registry-seed-v1|') || manifest.schemaVersion.startsWith('registry-seed-v2|') || manifest.schemaVersion.startsWith('registry-seed-v3|') || manifest.schemaVersion.startsWith('registry-seed-v4|')) {
   if(JSON.stringify(grant.contentClasses)!==JSON.stringify(['pantry','recipe','shopping']))throw Error('CONTENT_CLASS_MISMATCH');
   if(!sourceRuntime||sourceRuntime.storage!==storage||sourceRuntime.scope?.scopeId!==expectedAuthority.scope.id||sourceRuntime.scope?.documentId!==manifest.sourceDocument||JSON.stringify(canonical(await sourceRuntime.authorize()))!==JSON.stringify(canonical(expectedAuthority)))throw Error('AUTHENTICATED_SOURCE_REQUIRED');
   const {replayAuthenticated}=await import('../domain/replay.mjs'),replayed=await replayAuthenticated({runtime:sourceRuntime,checkpoint:source.bytes});if(replayed.held.length)throw Error('INCOMPLETE_SOURCE');
   const visible=d=>Object.fromEntries(Object.entries(d.toJSON()).filter(([,v])=>v&&typeof v==='object'&&Object.keys(v).length));if(!eq(canonical(visible(old)),canonical(visible(replayed.doc))))throw Error('SOURCE_MISMATCH');

   const parts=manifest.schemaVersion.split('|');if(parts.length!==3||!/^[0-9a-f-]{36}$/.test(parts[1])||!/^[1-9][0-9]*$/.test(parts[2]))throw Error('PROJECTION_MISMATCH');
   const markers=old.getMap('domain-effects').toJSON(),seeded=Object.entries(markers).filter(([,m])=>m?.version===3);if(seeded.length){const record=await storage.readProjectionSeed(expectedAuthority,manifest.sourceDocument);if(!record.ok||!record.value)throw Error('UNVERIFIED_SEED');const expected=new Map(record.value.seed.identities.map(x=>[x.effectId,x.commandId]));if(seeded.length!==expected.size||seeded.some(([id,m])=>m.seedId!==record.value.seed.seedId||m.effectId!==id||m.commandId!==expected.get(id)))throw Error('UNVERIFIED_SEED')}
   const {projectCurrentSeed}=await import('../compromise/current-seed.mjs');const v2=[2,3,4].includes(manifest.version);if(v2?parts[0]!==`registry-seed-v${manifest.version}`:parts[0]!=='registry-seed-v1')throw Error('PROJECTION_MISMATCH');const seed=projectCurrentSeed({LoroDoc,source:source.bytes,seedId:parts[1],peerId:parts[2],includeLocalMapping:v2,schemaVersion:manifest.version===4?4:1});if(hex(seed.snapshot)!==hex(snapshot))throw Error('PROJECTION_MISMATCH');
   if(v2){if(!policyBundle||!disclosureService||manifest.sourceRevision!==source.revision)throw Error('PROVENANCE_REQUIRED');const {verifySourcePolicyProjection}=await import('../disclosure/policy-seed.mjs');const {localMapping,...safeSeed}=seed;await verifySourcePolicyProjection({runtime:sourceRuntime,service:disclosureService,provider,seed:safeSeed,bundle:policyBundle,bundleHash:manifest.policyBundleHash})}
   return {status:'verified',sourceDocument:{documentId:manifest.sourceDocument,revision:source.revision},seed:{seedId:seed.seedId,identities:seed.identities},...(v2?{policySeed:{bundle:policyBundle,bundleHash:manifest.policyBundleHash}}:{})};
  }

  if(hex(fresh.export({mode:'snapshot'}))!==hex(snapshot)) throw Error('PROJECTION_MISMATCH');
  const title=old.getMap('recipe').get('title'), purchases=old.getMap('purchases').toJSON();
  if(typeof title!=='string' || !grant.contentClasses.includes('recipe') || !grant.contentClasses.includes('shopping') || !purchases || Array.isArray(purchases) || Object.values(purchases).some(v=>typeof v!=='string')) throw Error('SOURCE_MISMATCH');
  const expected={recipe:{title},purchases};
  if(!eq(canonical(fresh.toJSON()),canonical(expected))) throw Error('PROJECTION_MISMATCH');
  const updates=fresh.exportJsonUpdates(undefined,undefined,false), sourceUpdates=old.exportJsonUpdates(undefined,undefined,false);
  const peers=x=>new Set(x.changes.map(c=>String(c.id).split('@')[1]));
  const oldPeers=peers(sourceUpdates);
  if([...peers(updates)].some(p=>!p || oldPeers.has(p)) || updates.changes.some(c=>c.msg!==null)) throw Error('PROJECTION_MISMATCH');
  const ops=updates.changes.flatMap(c=>c.ops);
  const expectedOps=[{container:'cid:root-recipe:Map',key:'title',value:title},...Object.entries(purchases).map(([key,value])=>({container:'cid:root-purchases:Map',key,value}))];
  const actual=ops.map(op=>({container:op.container,key:op.content?.key,value:op.content?.value}));
  const sort=a=>a.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if(ops.some(op=>op.content?.type!=='insert') || !eq(sort(actual),sort(expectedOps))) throw Error('PROJECTION_MISMATCH');
  return {status:'verified',sourceDocument:{documentId:manifest.sourceDocument,revision:source.revision}};
 } catch(e) {throw Error(e instanceof Error ? e.message : 'INVALID_PROOF')}
}
