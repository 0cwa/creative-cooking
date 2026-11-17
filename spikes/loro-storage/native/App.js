import React, {useEffect, useState} from 'react';
import {ScrollView, Text} from 'react-native';
import {open} from '@op-engineering/op-sqlite';
import {LoroDoc} from 'loro-react-native';
import {run} from './scenario';

export default function App() {
 const [result,setResult]=useState('RUNNING');
 useEffect(()=>{ try { if (!global.HermesInternal) throw Error('Hermes required'); const report = run(LoroDoc, () => open({name:'s1-storage-fixture.sqlite'})); console.log('S1_RESULT Hermes', report); setResult(report); } catch(e) { console.error('S1_FAILURE', e.stack||e.message); setResult('FAIL: '+(e.stack||e.message)); } },[]);
 return <ScrollView><Text selectable testID="result">{result}</Text></ScrollView>;
}
