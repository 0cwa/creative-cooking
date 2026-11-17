import React,{useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {GuardianRestore} from './GuardianRestore';
export function GuardianStart(){
 const [setup,setSetup]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const start=async()=>{setBusy(true);try{
  const [{default:sodium},{default:initLoro,LoroDoc},{openIndexedDBStorage},{openBrowserMaster},workflow]=await Promise.all([import('libsodium-wrappers'),import('loro-crdt/web/loro_wasm.js'),import('../../storage/indexeddb.ts'),import('../../storage/browser-master.ts'),import('./guardian-workflow.mjs')]);
  await sodium.ready;await initLoro(new URL('./loro_wasm_bg.wasm?v=1.17.1',import.meta.url));
  const provider={hash:async(b:Uint8Array)=>sodium.crypto_generichash(32,b),verify:async(ref:string,b:Uint8Array,s:Uint8Array)=>sodium.crypto_sign_verify_detached(s,b,sodium.from_hex(ref))};let trust:any=null,pin='';
  const requireTrust=()=>{if(!trust)throw Error('VERIFY_OWNER_FIRST');return trust};
  const actions={fingerprint:(bundle:any)=>workflow.holderFingerprint(sodium,bundle),acceptAuthority:async(bundle:any,confirmedPin:string)=>{if(!/^[0-9a-f]{64}$/.test(confirmedPin))throw Error('INVALID_AUTHORITY');const next=await openIndexedDBStorage(`guardian-restorer-trust-${confirmedPin}`);try{await workflow.acceptGuardianAuthority({storage:next.storage,authorityProvider:provider,bundle,confirmedPin})}catch(e){next.close();throw e}trust?.close();trust=next;pin=confirmedPin},pin:(bundle:any,fingerprint:string)=>workflow.pinHolder({sodium,run:requireTrust().recoveryTransaction,bundle,confirmedFingerprint:fingerprint}),reconstruct:(message:any,contributions:any[])=>workflow.guardianReconstructor({sodium,run:requireTrust().recoveryTransaction,storage:trust.storage,authorityProvider:provider,pin}).reconstruct({message,contributions})};
  const openDestination=async()=>{requireTrust();const name=`guardian-restored-${pin}`,master=await openBrowserMaster(`${name}-master`),db=await openIndexedDBStorage(`${name}-records`);try{const keys=db.localKeys(master,sodium);await keys.provision('recovery-master');return {master,keys,storage:db.storage,run:db.recoveryTransaction,masterId:'recovery-master',close:()=>{db.close();master.close()}}}catch(e){db.close();master.close();throw e}};
  setSetup({actions,sodium,LoroDoc,openDestination});
 }catch(e){setError(e instanceof Error?e.message:'Could not open guardian recovery.')}finally{setBusy(false)}};
 return <View style={{gap:8}}><Text accessibilityRole="header">Restore with guardians</Text><Text>Verify the owner root pin and every guardian fingerprint independently. You also need the separately retained encrypted archive.</Text>{!setup?<Pressable accessibilityRole="button" disabled={busy} onPress={()=>void start()}><Text>Open guardian recovery</Text></Pressable>:<GuardianRestore {...setup}/>} {error?<Text accessibilityRole="alert">{error}</Text>:null}</View>;
}
