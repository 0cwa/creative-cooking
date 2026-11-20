import React,{useState} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import {GuardianControls} from './GuardianControls';
export function GuardianHolder({guardians}:{guardians:any}){
 const [holder,setHolder]=useState(''),[actions,setActions]=useState<any>(null),[error,setError]=useState('');
 return <View style={{gap:8}}><Text accessibilityRole="header">Keep a guardian share</Text><Text>Use the name agreed with the owner. Confirm the owner root pin and all guardian fingerprints through a separate channel.</Text><TextInput accessibilityLabel="My guardian name" value={holder} onChangeText={setHolder}/><Pressable accessibilityRole="button" onPress={()=>{void guardians.holder(holder).then(setActions,(e:Error)=>setError(e.message))}}><Text>Open my guardian keys</Text></Pressable>{error?<Text accessibilityRole="alert">{error}</Text>:null}{actions?<GuardianControls role="holder" actions={actions} onKit={async()=>{throw Error('INVALID_ROLE')}}/>:null}</View>;
}
