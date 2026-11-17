import React,{useEffect,useState} from 'react';
import {Button,ScrollView,Text,NativeModules} from 'react-native';
import {exportFile} from './compat-root/transport/adapter.mjs';
import sodium from './compat-root/native/sodium';
import {workspaceProof} from './workspace-proof';
import {openLocalWorkspace} from './compat-root/app/bootstrap';
import {shareEncryptedObject,pickEncryptedObject} from './compat-root/native/file-transfer';
export default function App(){
 const [result,setResult]=useState('RUNNING'),[transfer,setTransfer]=useState('');
 useEffect(()=>{workspaceProof().then(x=>{console.log('WORKSPACE_RESULT',x);setResult(x)},e=>{console.error('WORKSPACE_FAILURE',e.stack||String(e));setResult('FAIL '+String(e))})},[]);
 const withWorkspace=async fn=>{const w=await openLocalWorkspace('workspace-proof',false);try{await fn(w)}finally{w.close()}};
 const share=()=>withWorkspace(async w=>{const list=(await w.household.storage.listOutboundObjects(w.household.scope.scopeId)).value,item=list[0];await shareEncryptedObject({id:item.objectId,bytes:item.bytes});console.log('FILE_SHARE_RESULT returned');setTransfer('Share sheet returned')}).catch(e=>{console.error('FILE_SHARE_FAILURE',String(e));setTransfer('Share failed '+String(e))});
 const prepare=()=>withWorkspace(async w=>{const list=(await w.household.storage.listOutboundObjects(w.household.scope.scopeId)).value,item=list[0],bytes=exportFile({id:item.objectId,bytes:item.bytes});await NativeModules.ProofKeyInvalidator.publishFixture(sodium.to_base64(bytes,sodium.base64_variants.ORIGINAL));setTransfer('Picker fixture prepared')}).catch(e=>setTransfer('Prepare failed '+String(e)));
 const pick=()=>withWorkspace(async w=>{const auth=await w.household.authorization(),item=await pickEncryptedObject({verifyObject:async bytes=>(await w.household.codec.openContent(bytes,auth.signingKeyRefs)).object});console.log('FILE_PICK_RESULT',item?'authenticated':'canceled');setTransfer(item?'Picked and authenticated':'Picker canceled')}).catch(e=>{console.error('FILE_PICK_FAILURE',String(e));setTransfer('Pick failed '+String(e))});
 return <ScrollView><Text testID="result">{result}</Text><Button title="Share encrypted fixture" onPress={share}/><Button title="Prepare picker fixture" onPress={prepare}/><Button title="Pick encrypted fixture" onPress={pick}/><Text>{transfer}</Text></ScrollView>;
}
