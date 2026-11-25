import {createContext,useContext,useEffect,useState,type PropsWithChildren} from 'react';
import {View} from 'react-native';
import {Text} from '@/theme/primitives';
import {subscribeActions} from './action.mjs';
export const LoroWorkspaceValue=createContext<any>(null);
export function LoroWorkspaceContext({workspace,children}:PropsWithChildren<{workspace:any}>) {return <LoroWorkspaceValue.Provider value={workspace}>{children}</LoroWorkspaceValue.Provider>}
/** Counts retained local encrypted objects, without inferring delivery. */
export function LoroWorkspaceStatus({revision}:{revision:string}) {
 const workspace=useContext(LoroWorkspaceValue),[refresh,setRefresh]=useState(0),[count,setCount]=useState<number|null>(null),[error,setError]=useState(false);
 useEffect(()=>{const update=()=>setRefresh(n=>n+1);const a=workspace.household.subscribe?.(update)??subscribeActions(workspace.household,update),b=subscribeActions(workspace.personal,update);return()=>{a();b()}},[workspace]);
 useEffect(()=>{let live=true;void(async()=>{try{const all=await Promise.all([
  workspace.household.listOutboundObjects?.()??workspace.household.storage.listOutboundObjects(workspace.household.scope.scopeId),
  workspace.personal.storage.listOutboundObjects(workspace.personal.scope.scopeId)
 ]);if(all.some((x:any)=>!x.ok))throw Error('IO');if(live){setCount(all.reduce((n:number,x:any)=>n+x.value.length,0));setError(false)}}catch{if(live){setCount(null);setError(true)}}})();return()=>{live=false}},[workspace,revision,refresh]);
 return <View accessibilityLabel="Local and exchange status" style={{gap:6}}><Text accessibilityLabel="Open household">{`${workspace.householdPairing.selectedHousehold ? 'Shared household' : 'Original local household'} · ${workspace.household.scope.scopeId}`}</Text><Text accessibilityLabel="Household document generation">Household generation {workspace.household.scope.documentGeneration}</Text><Text>Saved on this device: shown by the local save status.</Text><Text>{error?'Encrypted update count is unavailable.':count===null?'Checking encrypted updates…':`${count} encrypted update${count===1?'':'s'} retained for exchange.`}</Text>{workspace.needsDisclosureRenewal?<Text>A household change requires a new disclosure policy before external sharing can be approved.</Text>:null}<Text>{workspace.readOnly?'This household is read-only. Editing and exchange are unavailable.':'Cooking updates can be exchanged directly on supported devices or by encrypted file.'}</Text></View>;
}
