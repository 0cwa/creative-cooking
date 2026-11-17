import React from 'react';
import {Button,Platform,Text,View} from 'react-native';
import {RecoveryStart} from './RecoveryStart';
export function LockedWorkspace({error,onRetry,onLegacy}:{error:string|null;onRetry:()=>void;onLegacy:()=>void}){
 return <View style={{padding:24,gap:16}}><Text accessibilityRole="header">Could not open the fresh local workspace</Text><Text>{error}</Text><Text>Your workspace has been kept. Retry after resolving the storage error.</Text><Button title="Retry" onPress={onRetry}/>{Platform.OS==='web'?<RecoveryStart/>:null}<Button title="Open existing workspace for this session" onPress={onLegacy}/></View>;
}
