import {open} from '@op-engineering/op-sqlite';
import {openSQLiteStorage} from './compat-root/storage/sqlite.ts';
import {LoroDoc} from './native-adapter';
import {sodium} from './native-sodium';
import {generate,verify} from './exchange.mjs';
const b=(...x)=>new Uint8Array(x);
const child=(op,revision,snapshot,envelope)=>({expectedAuthority:{version:2,scope:{kind:'personal',id:'scope'},record:null},scopeId:'scope',operationId:op,documents:[{documentId:'doc',bytes:snapshot,expectedRevision:revision}],commands:[{version:1,commandId:op,effectId:op,documentId:'doc',kind:'write',payload:b(2),dependencyEffectIds:[]}],outbound:[{object:{id:op,bytes:envelope},branchHead:'h',epochId:'e'}]});
const check=(x,message)=>{if(!x)throw Error(message)};
export async function rootStorageProbe(){
 const db=open({name:'root-storage-proof.sqlite'});let fault='';const storage=openSQLiteStorage(db,x=>{if(x===fault)throw Error('injected')});
 try{
  const old=await storage.getLocalOperation('scope','saved');check(old.ok,'read local');
  if(old.value){const doc=(await storage.reopenDocument('scope','doc')).value;const d=new LoroDoc();d.import(doc.bytes);check(d.getMap('recipe').get('title')==='imported','restored document');check((await storage.getLocalOperation('scope','failed')).value===null,'failed edit persisted');check((await storage.getInboxApplication('scope','incoming')).value?.operationId==='import','applied status');const outbound=(await storage.listOutboundObjects('scope')).value;check(outbound.length===1,'outbound restored');const decoded=JSON.parse(new TextDecoder().decode(outbound[0].bytes));const verified=await verify(sodium,decoded);const sender=new LoroDoc();sender.import(Uint8Array.from(verified.update));check(sender.getMap('recipe').get('title')==='saved','authenticated outbound update');return 'PASS root storage restored committed document, effect, outbound and inbox after process restart';}
  const d=new LoroDoc();d.setPeerId('11');d.getMap('recipe').set('title','saved');const saved=d.export({mode:'snapshot'});const packet=await generate(sodium,'native',d.export({mode:'update'}));const envelope=new TextEncoder().encode(JSON.stringify(packet));
  check((await storage.commitLocal(child('saved',null,saved,envelope))).ok,'local commit');
  d.getMap('recipe').set('title','failed');const failed=child('failed',0,d.export({mode:'snapshot'}),envelope);
  for(const boundary of ['write','local']) {fault=boundary;check(!(await storage.commitLocal(failed)).ok,'fault '+boundary);fault='';check((await storage.getLocalOperation('scope','failed')).value===null,'rollback operation');const loaded=new LoroDoc();loaded.import((await storage.reopenDocument('scope','doc')).value.bytes);check(loaded.getMap('recipe').get('title')==='saved','rollback doc');check((await storage.listOutboundObjects('scope')).value.length===1,'rollback outbound');}
  const item={scopeId:'scope',object:{id:'incoming',bytes:b(5)},source:'relay',expectedCursor:null,cursor:'cursor'};
  fault='inbox';check(!(await storage.stageInbox(item)).ok,'inbox injection');fault='';check((await storage.stageInbox(item)).ok,'stage inbox');
  d.getMap('recipe').set('title','imported');const imp={version:2,expectedAuthority:{version:2,scope:{kind:'personal',id:'scope'},record:null},scopeId:'scope',operationId:'import',itemId:'incoming',documents:[{documentId:'doc',bytes:d.export({mode:'snapshot'}),expectedRevision:0}],commands:[{version:1,commandId:'remote',effectId:'remote',documentId:'doc',kind:'write',payload:b(1),dependencyEffectIds:[]}],effectIds:['remote']};
  for(const boundary of ['import-documents','import']){fault=boundary;check(!(await storage.commitImport(imp)).ok,'import injection');fault='';check((await storage.getInboxApplication('scope','incoming')).value===null,'inbox status rollback');check((await storage.reopenDocument('scope','doc')).value.revision===0,'import document rollback');}
  check((await storage.commitImport(imp)).ok,'import success');return 'PASS root storage local/outbound and inbox/import fault injection';
 }finally{db.close()}
}
