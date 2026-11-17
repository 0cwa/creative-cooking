import {useContext,useEffect,useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {LoroWorkspaceValue} from './WorkspaceStatus';
import {executeAction} from './action.mjs';
export function RecoveryReminder() {
 const workspace=useContext(LoroWorkspaceValue),[dismissed,setDismissed]=useState<boolean|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
 useEffect(()=>{let active=true;void workspace.personal.document().then(({doc}:any)=>{if(active)setDismissed(doc.getMap('personal-preferences').get('recoveryReminderDismissed')===true)},()=>{if(active)setError('Could not read recovery reminder.')});return()=>{active=false}},[workspace]);
 const dismiss=async()=>{setBusy(true);setError(null);try{const actionId=crypto.randomUUID(),id=`${actionId}:1`;await executeAction(workspace.personal,workspace.sequences,actionId,[{version:1,kind:'personal-preference-put',commandId:id,effectId:id,dependencyEffectIds:[],data:{key:'recoveryReminderDismissed',value:true}}]);setDismissed(true)}catch(e){setError(e instanceof Error?e.message:'Could not save your choice.')}finally{setBusy(false)}};
 if(dismissed)return null;
 return <View style={{gap:6}}><Text accessibilityRole="header">Recovery is not configured</Text><Text>Recovery setup is not available in this preview yet. A recovery code can restore keys, but it cannot recreate missing data copies. Keep a separate data copy when encrypted export becomes available.</Text>{error?<Text accessibilityRole="alert">{error}</Text>:null}<Pressable accessibilityRole="button" accessibilityLabel="Dismiss recovery reminder" disabled={busy||dismissed===null} onPress={()=>void dismiss()}><Text>Dismiss reminder</Text></Pressable></View>;
}
