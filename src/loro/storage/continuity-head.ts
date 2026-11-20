/** Append-only continuity evidence: a pointer alone cannot retire newer retained bindings. */
type Reader={get(key:string):Promise<any>;keys():Promise<string[]>};
type Head={generation:number;bindingHash:string};
type ReadResult={ok:false}|{ok:true;value:null|{head:Head;record:any}};
const key=(...x:string[])=>JSON.stringify(x);
const object=(x:any)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&!(x instanceof Uint8Array);
const fields=(x:any,n:string[])=>object(x)&&Object.keys(x).length===n.length&&n.every(k=>Object.hasOwn(x,k));
const id=(x:any)=>typeof x==='string'&&x.length>0&&new TextEncoder().encode(x).length<=256;
const generation=(x:any)=>Number.isSafeInteger(x)&&x>=0;
export async function readContinuityHead(tx:Reader,scopeId:string,owner:string):Promise<ReadResult>{
 const head=await tx.get(key('continuity-head',scopeId,owner)),records:{generation:number;record:any}[]=[];
 for(const raw of await tx.keys()){
  let parts:any;try{parts=JSON.parse(raw)}catch{continue}
  if(!Array.isArray(parts)||parts[0]!=='continuity-binding'||parts[1]!==scopeId||parts[2]!==owner)continue;
  if(parts.length!==4||JSON.stringify(parts)!==raw||typeof parts[3]!=='string'||!/^(0|[1-9][0-9]*)$/.test(parts[3]))return {ok:false};
  const n=Number(parts[3]),record=await tx.get(raw),b=record?.binding;
  if(!generation(n)||!fields(record,['version','binding','bindingSignature','bindingHash'])||record.version!==1||!id(record.bindingHash)||typeof record.bindingSignature!=='string'||!/^[0-9a-f]{128}$/.test(record.bindingSignature)||!fields(b,['version','householdId','owner','checkpoint','signerDevice','generation','continuityKey'])||b.version!==1||b.householdId!==scopeId||b.owner!==owner||b.generation!==n||![b.householdId,b.owner,b.checkpoint,b.signerDevice].every(id)||typeof b.continuityKey!=='string'||!/^[0-9a-f]{64}$/.test(b.continuityKey))return {ok:false};
  records.push({generation:n,record});
 }
 if(head===undefined&&records.length===0)return {ok:true,value:null};
 if(!fields(head,['generation','bindingHash'])||!generation(head.generation)||!id(head.bindingHash)||records.length===0)return {ok:false};
 records.sort((a,b)=>a.generation-b.generation);
 // Registration preserves every generation from zero; gaps are partial durable damage.
 if(records.some((r,i)=>r.generation!==i))return {ok:false};
 const latest=records[records.length-1];
 if(head.generation!==latest.generation||head.bindingHash!==latest.record.bindingHash)return {ok:false};
 return {ok:true,value:{head,record:latest.record}};
}
