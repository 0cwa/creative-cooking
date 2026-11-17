import React from 'react';
import {PersonalRecoveryPanel} from './PersonalRecoveryPanel';
async function restore(archive:any,code:string){
 const [{default:sodium},{default:initLoro,LoroDoc},{openIndexedDBStorage},{openBrowserMaster},{projectPersonal},{openRecoveryArchive,restoreOfflineArchive,readRecoveredSnapshot}]=await Promise.all([import('libsodium-wrappers'),import('loro-crdt/web/loro_wasm.js'),import('../storage/indexeddb.ts'),import('../storage/browser-master.ts'),import('../domain/personal-codec.mjs'),import('./recovery-archive.mjs')]);
 await sodium.ready;await initLoro(new URL('./loro_wasm_bg.wasm?v=1.17.1',import.meta.url));
 const verified=await openRecoveryArchive(sodium,archive,code),body=verified.body;
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(archive)))),name='recovery-'+Array.from(digest,x=>x.toString(16).padStart(2,'0')).join('');
 const openDestination=async()=>{const master=await openBrowserMaster(`${name}-master`),db=await openIndexedDBStorage(`${name}-records`);try{const keys=db.localKeys(master,sodium);await keys.provision('recovery-master');return {master,keys,storage:db.storage,run:db.recoveryTransaction,masterId:'recovery-master',close:()=>{db.close();master.close()}}}catch(e){db.close();master.close();throw e}};
 const status=await restoreOfflineArchive({sodium,archive,code,operationId:'personal-archive',openDestination});const target=await openDestination();try{const doc=body.snapshot?await readRecoveredSnapshot({sodium,run:target.run,master:target.master,masterId:target.masterId,owner:body.owner,scopeId:body.scopeId,operationId:'personal-archive',documentId:body.snapshot.documentId,LoroDoc}):null;return {status,personal:doc?projectPersonal(doc):null}}finally{target.close()}
}
export function RecoveryStart(){return <PersonalRecoveryPanel restore={restore}/>}
