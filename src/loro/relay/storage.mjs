// Foreground orchestration only. The caller owns scheduling and envelope authentication.
const encoder=new TextEncoder();
const id=x=>typeof x==='string' && x.length>0 && encoder.encode(x).length<=256;
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
export function durableRelay({client,storage,scopeId,source,relayId}) {
 if(!client || typeof client.put!=='function' || typeof client.list!=='function' || typeof client.get!=='function' || typeof storage?.stageInbox!=='function' || typeof storage?.recordReceipt!=='function' || ![scopeId,source,relayId].every(id) || client.relayId!==relayId) throw Error('MALFORMED');
 return {
  async send(object) {
   const receipt=await client.put(object); // put verifies the configured relay identity and complete request binding.
   const bytes=encoder.encode(JSON.stringify(receipt));
   const receiptId=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
   const result=await storage.recordReceipt({scopeId,objectId:receipt.claims.objectId,receiptId,destination:'relay',recipientId:relayId,state:'stored',bytes});
   if(!result.ok) throw Error(result.error);
   return {receipt,replayed:result.value.replayed};
  },
  async fetchAndStage(expectedCursor) {
   if(expectedCursor!==null && !id(expectedCursor)) throw Error('MALFORMED');
   const page=await client.list({after:expectedCursor,limit:1});
   if(!page.objects.length) return {staged:false,cursor:expectedCursor};
   const object=await client.get(page.objects[0].id);
   if(object.bytes.length!==page.objects[0].size) throw Error('INVALID_PROOF');
   const result=await storage.stageInbox({scopeId,object,source,expectedCursor,cursor:page.cursor});
   if(!result.ok) throw Error(result.error);
   return {staged:true,objectId:object.id,cursor:page.cursor};
  }
 };
}
