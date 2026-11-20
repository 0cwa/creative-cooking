import React from 'react';
import {Button,Platform,Text,View} from 'react-native';
import {RecoveryStart} from './RecoveryStart';
export function LockedWorkspace({error,onRetry,onOriginal}:{error:string|null;onRetry:()=>void;onOriginal?:()=>void}){
 return <View style={{padding:24,gap:16}}><Text accessibilityRole="header">Could not open the fresh local workspace</Text><Text>{error}</Text><Text>Your workspace has been kept. Retry after resolving the storage error.</Text><Button title="Retry" onPress={onRetry}/>{onOriginal?<Button title="Return to original local household" onPress={onOriginal}/>:null}{Platform.OS==='web'?<RecoveryStart/>:null}</View>;
}
