import {createContext,useContext,useEffect,useState,type PropsWithChildren} from 'react';
import {Text,View} from 'react-native';
const Context=createContext<any>(null);
export function LoroWorkspaceContext({workspace,children}:PropsWithChildren<{workspace:any}>) {return <Context.Provider value={workspace}>{children}</Context.Provider>}
/** Counts retained local encrypted objects, without inferring delivery. */
export function LoroWorkspaceStatus({revision}:{revision:string}) {
 const workspace=useContext(Context),[count,setCount]=useState<number|null>(null),[error,setError]=useState(false);
 useEffect(()=>{let live=true;void(async()=>{try{const scopes=[workspace.household.scope.scopeId,workspace.personal.scope.scopeId],all=await Promise.all(scopes.map(id=>workspace.household.storage.listOutboundObjects(id)));if(all.some((x:any)=>!x.ok))throw Error('IO');if(live){setCount(all.reduce((n:number,x:any)=>n+x.value.length,0));setError(false)}}catch{if(live){setCount(null);setError(true)}}})();return()=>{live=false}},[workspace,revision]);
 return <View accessibilityLabel="Local and exchange status" style={{gap:6}}><Text>Saved on this device: shown by the local save status.</Text><Text>{error?'Encrypted update count is unavailable.':count===null?'Checking encrypted updates…':`${count} encrypted update${count===1?'':'s'} retained for exchange.`}</Text><Text>Exchange, relay storage and peer receipt reporting are not available in this preview.</Text><Text>Quarantine status is not available in this preview.</Text></View>;
}
