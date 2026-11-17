import React, {useEffect, useState} from 'react';
import {ScrollView, Text} from 'react-native';
import {open} from '@op-engineering/op-sqlite';
import {LoroDoc} from 'loro-react-native';
import {sodium} from './native-sodium';
import {run} from './scenario';
import {compatibility} from './compat';
import {LoroDoc as Adapter} from './native-adapter';
import {generate, verify} from './exchange.mjs';
import packet from './browser-packet.json';
import {cryptoVectors} from './crypto-vectors';
import {masterProbe} from './master-probe';
import {localKeysProbe} from './local-keys-probe';
import {rootStorageProbe} from './root-storage-probe';
import {bootstrapProbe} from './bootstrap-probe';

export default function App() {
 const [result,setResult]=useState('RUNNING');
 useEffect(()=>{(async()=>{try {
  if (!global.HermesInternal) throw Error('Hermes required');
  const storage=run(LoroDoc,()=>open({name:'s1-storage-fixture.sqlite'}));
  const compat=compatibility();
  console.log('COMPAT_RESULT',JSON.stringify(compat));
  if(Object.values(compat.checks).some(value=>value!=='PASS'))throw Error('Loro compatibility assertion failed');
  const vectors=cryptoVectors();
  const master=await masterProbe();
  const localKeys=await localKeysProbe();
  const rootStorage=await rootStorageProbe();
  const bootstrap=await bootstrapProbe();
  const browser=await verify(sodium,packet);
  const received=new Adapter();received.import(Uint8Array.from(browser.update));if(received.getMap('exchange').get('title')!=='browser')throw Error('browser Loro update');
  const sender=new Adapter();sender.setPeerId('99');sender.getMap('exchange').set('title','native');
  const native=await generate(sodium,'native',sender.export({mode:'update'}));
  await verify(sodium,native);
  console.log('S1_RESULT Hermes',storage);
  console.log('MASTER_RESULT',master);
  console.log('LOCAL_KEYS_RESULT',localKeys);
  console.log('ROOT_STORAGE_RESULT',rootStorage);
  console.log('BOOTSTRAP_RESULT',bootstrap);
  console.log('EXCHANGE_RESULT',JSON.stringify({vectors,browser,native}));
  setResult(JSON.stringify({storage,compat:compat.checks,vectors,master,localKeys,rootStorage,bootstrap,browser}));
 } catch(e) {console.error('NATIVE_FAILURE',e.stack||e.message);setResult('FAIL: '+(e.stack||e.message));}})();},[]);
 return <ScrollView><Text selectable testID="result">{result}</Text></ScrollView>;
}
