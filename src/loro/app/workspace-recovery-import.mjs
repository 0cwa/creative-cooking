import {openRecoveryArchive,restoreOfflineArchive,readRecoveredSnapshot} from './recovery-archive.mjs';
import {withRecoveredContinuity} from './personal-recovery.mjs';
import {projectPersonal} from '../domain/personal-codec.mjs';
import {recoveryHash} from '../recovery/enrollment.mjs';

/** The imported personal history is scoped separately from both live runtimes. */
export function workspaceRecoveryImport({sodium,run,storage,master,keys,masterId,LoroDoc,deviceId,lock}){
 const slot=JSON.stringify(['recovery-install','workspace-import',deviceId]);
 async function read(){
  const saved=await run(false,tx=>tx.get(slot));
  if(!saved)return null;
  const doc=saved.documentId?await readRecoveredSnapshot({sodium,run,master,masterId,LoroDoc,...saved}):null;
  if(saved.documentId&&!doc)throw Error('MISSING_SNAPSHOT');
  return {status:saved.status,personal:doc?projectPersonal(doc):null};
 }
 return {
  read,
  async restore(archive,code,guardianPackage){
   const {body}=await openRecoveryArchive(sodium,archive,code);
   if(guardianPackage&&recoveryHash(sodium,body.package)!==recoveryHash(sodium,guardianPackage))throw Error('INVALID_PACKAGE');
   const digest=recoveryHash(sodium,archive),operationId=`archive:${digest}`;
   return lock(async()=>{
    const status=await restoreOfflineArchive({sodium,archive,code,operationId,openDestination:async()=>({master,keys,storage,run,masterId})});
    const saved={operationId,owner:body.owner,scopeId:body.scopeId,generation:body.catalog.generation,
     documentId:body.snapshot?.documentId??null,
     status:{archiveAccess:status.archiveAccess,archiveCiphertextCopies:status.archiveCiphertextCopies,
      availableObjects:status.availableObjects,missingObjects:status.missingObjects,recoverableKeys:body.catalog.keyRefs.length}};
    await run(true,tx=>tx.put(slot,saved));
    return read();
   });
  },
  async useContinuity(use){
   const saved=await run(false,tx=>tx.get(slot));
   if(!saved)throw Error('MISSING_RECOVERY');
   return withRecoveredContinuity({run,master,masterId,...saved},credential=>use(saved,credential));
  }
 };
}
