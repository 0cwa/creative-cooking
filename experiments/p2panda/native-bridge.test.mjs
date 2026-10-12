import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { startNativeBridge } from './native-bridge.mjs';
import { encodeFrame } from './contract.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
test('local native bridge rejects wrong topic, unauthorized read/edit, wrong space, malformed and replay',async()=>{
 const published=[];
 const peer={received:[],publish(x){published.push(Buffer.from(x));}};
 const topic=randomBytes(32).toString('hex'),token=randomBytes(24).toString('hex');
 const bridge=await startNativeBridge(peer,topic,token,'space:personal:automerge');
 try {
   assert.equal(bridge.server.address().address,'127.0.0.1');
   const headers={'X-Spike-Token':token};
   const send=async(method,url,body,h=headers)=>{
     const res=await fetch(url,{method,headers:h,...(body?{body}:{})});
     return {status:res.status,body:await res.json()};
   };
   assert.equal((await send('GET',bridge.url+bridge.endpoint,null,{})).status,401);
   assert.equal((await send('GET',bridge.url+bridge.endpoint,null,{'X-Spike-Token':'stale'})).status,401);
   assert.equal((await send('GET',bridge.url+'/v1/native/'+randomBytes(32).toString('hex')+'/frames')).status,404);
   const wrong=encodeFrame({documentId:'space:personal:loro/doc:one',bytes:new Uint8Array([1,2])});
   assert.equal((await send('POST',bridge.url+bridge.endpoint,wrong)).status,403);
   assert.equal((await send('POST',bridge.url+bridge.endpoint,Buffer.from('not a valid frame'))).status,422);
   assert.equal(published.length,0);
   const payload=new Uint8Array([0,255,100,1]);
   const frame=encodeFrame({documentId:'space:personal:automerge/doc:one',bytes:payload});
   const ok=await send('POST',bridge.url+bridge.endpoint,frame);
   assert.equal(ok.status,202);
   assert.equal(ok.body.sha256,hash(payload));
   assert.equal(published.length,1);
   const dup=await send('POST',bridge.url+bridge.endpoint,frame);
   assert.equal(dup.status,200);
   assert.equal(dup.body.replayNoop,true);
   assert.equal(published.length,1,'boundary replay suppressed, NOT p2panda replay proof');
   peer.received.push(published[0]);
   const list=await send('GET',bridge.url+bridge.endpoint);
   assert.equal(list.status,200);
   assert.equal(list.body.frames.length,1);
   assert.equal(list.body.frames[0].bytesBase64,Buffer.from(payload).toString('base64'));
 }finally{await bridge.close();}
});
