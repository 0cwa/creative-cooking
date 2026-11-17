import {useContext,useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {LoroWorkspaceValue} from './WorkspaceStatus';

/** Public device identifiers can be shared with an organizer; possession of
 * this bundle alone grants no household access. */
export function HouseholdIdentity(){
 const workspace=useContext(LoroWorkspaceValue),[open,setOpen]=useState(false),[copied,setCopied]=useState(false);
 const identity=workspace.householdPairing?.identity;if(!identity)return null;
 const bundle=JSON.stringify(identity);
 return <View style={{gap:6}}><Pressable accessibilityRole="button" onPress={()=>setOpen(!open)}><Text>{open?'Hide device identity':'Show device identity'}</Text></Pressable>{open?<><Text accessibilityRole="header">Public device identity</Text><Text>Share this with the household organizer, then compare the device keys with them independently before confirming an invitation. Sharing this does not grant access.</Text><Text selectable accessibilityLabel="Public device identity">{bundle}</Text><Pressable accessibilityRole="button" onPress={()=>void Clipboard.setStringAsync(bundle).then(()=>setCopied(true))}><Text>Copy public device identity</Text></Pressable>{copied?<Text>Copied.</Text>:null}</>:null}</View>;
}
