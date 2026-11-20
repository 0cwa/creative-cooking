// The draft, once present, is authoritative for immutable retry parameters.
/** @param {{run:any,owner:string,workspaceName:string,createGeneration:any,locks:any,epochId?:string|null,
 * rotated?:boolean,authority?:{scope:{id:string},record:{authorizationSnapshot:string,revision:number}}|null}} options */
export function createGuardianPreparation({run,owner,workspaceName,createGeneration,locks,epochId=null,rotated=false,authority=null}) {
 const encoder=new TextEncoder();
 return async function prepare(holders,threshold) {
  if(!Array.isArray(holders)||holders.length<1||holders.length>255||!Number.isInteger(threshold)||threshold<1||threshold>holders.length)throw Error('INVALID_INPUT');
  for(let i=0;i<holders.length;i++)if(!Object.hasOwn(holders,i)||typeof holders[i]!=='string'||!holders[i].length||holders[i].length>128||encoder.encode(holders[i]).length>128)throw Error('INVALID_INPUT');
  if(new Set(holders).size!==holders.length)throw Error('INVALID_INPUT');
  holders=[...holders];
  if(typeof locks?.request!=='function')throw Error('LOCK_UNAVAILABLE');
  const slot=JSON.stringify(['recovery-generation-operation','app-pending',owner]);
  return locks.request(JSON.stringify(['creative-cooking/guardian-prepare/v1',workspaceName,owner]),{mode:'exclusive'},async()=>{
   const operationId=await run(true,async tx=>{
    if(authority){
     const selected=await tx.get(JSON.stringify(['pairing-authority','personal',authority.scope.id]));
     if(!selected||selected.authorizationSnapshot!==authority.record.authorizationSnapshot||
       selected.revision!==authority.record.revision)throw Error('CONFLICT');
    }
    const saved=await tx.get(slot);
    if(saved!==undefined&&(!saved||typeof saved.operationId!=='string'||!saved.operationId.length||saved.operationId.length>128))throw Error('CORRUPT');
    if(saved!==undefined&&(!epochId||saved.epochId===epochId||saved.epochId===undefined&&!rotated)){
     const draft=await tx.get(JSON.stringify(['recovery-generation-operation','guardian-draft',owner,saved.operationId]));
     if(draft===undefined&&(JSON.stringify(saved.holders)!==JSON.stringify(holders)||saved.threshold!==threshold))await tx.put(slot,{operationId:saved.operationId,holders,threshold,...epochId&&{epochId}});
     return saved.operationId;
    }
    const operationId=globalThis.crypto.randomUUID();
    await tx.put(slot,{operationId,holders,threshold,...epochId&&{epochId}});
    return operationId;
   });
   return createGeneration({operationId,holders,threshold,...authority&&{expectedSnapshot:authority.record.authorizationSnapshot}});
  });
 };
}
