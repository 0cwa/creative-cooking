import vector from './recovery-vector.mjs';
import {createRecovery,recover} from './recovery.mjs';
export async function recoveryProbe() {
 const keys={a:new Uint8Array(32).fill(1),b:new Uint8Array(32).fill(2),c:new Uint8Array(32).fill(3)};
 const data=new TextEncoder().encode('personal fixture');
 const unhex=s=>Uint8Array.from(s.match(/../g),x=>parseInt(x,16));
 const fixed={payloadNonce:unhex(vector.payloadNonce),payload:unhex(vector.payload),envelopes:vector.envelopes.map(e=>({...e,nonce:unhex(e.nonce),box:unhex(e.box)}))};
 if(Array.from(await recover(vector.meta,fixed,['a','c'],keys)).join(',')!==Array.from(new TextEncoder().encode('fixed recovery fixture')).join(',')) throw Error('fixed recovery vector');
 const eq=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
 const fail=async f=>{try{await f();}catch{return;}throw Error('invalid recovery accepted');};
 for (const meta of [{owner:'alice',scope:'personal',generation:1,threshold:1,holders:['a']},{owner:'alice',scope:'personal',generation:2,threshold:2,holders:['a','b','c']}]) {
  const pkg=await createRecovery(meta,keys,data), selected=meta.holders.slice(0,meta.threshold);
  if(!eq(await recover(meta,pkg,selected,keys),data))throw Error('recovery failed');
  for(const bad of [{...meta,owner:'bob'},{...meta,scope:'shared'},{...meta,generation:meta.generation+1},{...meta,threshold:1-meta.threshold}]) await fail(()=>recover(bad,pkg,selected,keys));
  await fail(()=>recover(meta,pkg,[selected[0],selected[0]],keys));
  await fail(()=>recover(meta,pkg,selected,{...keys,[selected[0]]:keys.c}));
  const changed={...pkg,envelopes:pkg.envelopes.map((x,i)=>i?x:{...x,index:x.index+1})}; await fail(()=>recover(meta,changed,selected,keys));
  const tampered={...pkg,payload:pkg.payload.slice()}; tampered.payload[0]^=1; await fail(()=>recover(meta,tampered,selected,keys));
  if(meta.threshold>1) await fail(()=>recover(meta,pkg,[selected[0]],keys));
 }
 return 'one-holder and 2-of-3 personal recovery envelopes and negative checks passed';
}
