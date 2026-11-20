import {readAuthority,verifyAuthority} from './chain.mjs';
import {domain} from './validator.mjs';

// Model authority recorded by the old selector, including branches that
// production now requires checkout to prepare.
export async function writeFixtureSelection(storage,scope,pin,provider,selection) {
 const {revision,state,activeHead}=await readAuthority(storage,scope,pin,provider);
 if(selection.from!==activeHead)throw Error('CONFLICT');
 state.selections.push(selection);
 state.activeHead=selection.to;
 await verifyAuthority(state,pin,provider);
 const signed=domain('authority-state',state);
 const [, ,canonicalState]=JSON.parse(new TextDecoder().decode(signed));
 const authorizationSnapshot=Buffer.from(await provider.hash(signed)).toString('hex');
 const authorityState=new TextEncoder().encode(JSON.stringify(canonicalState));
 const result=await storage.compareAndSwapPairingAuthority({expectedRevision:revision,record:{
  scope,revision:revision+1,acceptedParent:state.activeHead,authorizationSnapshot,authorityState
 }});
 if(!result.ok)throw Error(result.error);
}
