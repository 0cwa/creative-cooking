import React,{useEffect,useState} from 'react';
import {ScrollView,Text} from 'react-native';
import {workspaceProof} from './workspace-proof';
export default function App(){const [result,setResult]=useState('RUNNING');useEffect(()=>{workspaceProof().then(x=>{console.log('WORKSPACE_RESULT',x);setResult(x)},e=>{console.error('WORKSPACE_FAILURE',e.stack||String(e));setResult('FAIL '+String(e))})},[]);return <ScrollView><Text testID="result">{result}</Text></ScrollView>}
