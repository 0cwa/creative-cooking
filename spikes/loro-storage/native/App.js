import React, {useEffect, useState} from 'react';
import {ScrollView, Text} from 'react-native';
import {open} from '@op-engineering/op-sqlite';
import {LoroDoc} from 'loro-react-native';
import {run} from './scenario';

export default function App() {
 const [result,setResult]=useState('RUNNING');
 useEffect(()=>{ try { setResult(run(LoroDoc, () => open({name:'s1-storage-fixture.sqlite'}))); } catch(e) { setResult('FAIL: '+(e.stack||e.message)); } },[]);
 return <ScrollView><Text selectable testID="result">{result}</Text></ScrollView>;
}
