import {test} from 'node:test';import assert from 'node:assert/strict';import {nativeEncryptedObjectChannel,nativeBinaryChannel} from './direct-transport.mjs';import {MAX_FRAME,exportFile} from '../transport/adapter.mjs';
class Channel {constructor(){this.readyState='open';this.bufferedAmount=0;this.listeners=new Map()}addEventListener(n,f){this.listeners.set(n,f)}removeEventListener(n){this.listeners.delete(n)}send(v){this.sent=new Uint8Array(v)}emit(v){this.listeners.get('message')?.({data:v})}}
test('binary channel enforces frame limits and snapshots bytes',async()=>{const c=new Channel(),received=[],errors=[];const b=nativeBinaryChannel(c,{onFrame:v=>received.push(v),onError:e=>errors.push(e)});const input=Uint8Array.of(1,2);await b.send(input);input[0]=9;assert.deepEqual([...c.sent],[1,2]);c.emit('text');assert.match(errors[0].message,/MALFORMED/);await assert.rejects(b.send(new Uint8Array(MAX_FRAME+1)),/TOO_LARGE/);b.close()});
test('direct object validates the authenticated identifier',async()=>{const c=new Channel(),objects=[],errors=[];const b=nativeEncryptedObjectChannel(c,{verifyObject:async bytes=>({id:'real',bytes}),onObject:o=>objects.push(o),onError:e=>errors.push(e)});c.emit(exportFile({id:'forged',bytes:Uint8Array.of(1)}));await new Promise(resolve=>setImmediate(resolve));assert.equal(objects.length,0);assert.match(errors[0].message,/INVALID_PROOF/);b.close()});


test('durable sends reject oversized and over-capacity payloads before queueing, then release capacity',async()=>{
 const {nativeDurableTransfer}=await import('./direct-transport.mjs'),framing=await import('../transport/adapter.mjs'),{createHash}=await import('node:crypto');
 let block=false,release;const gate=new Promise(resolve=>{release=resolve}),sha256=async bytes=>{if(block)await gate;return createHash('sha256').update(bytes).digest('hex')},channel=new Channel(),transfer=await nativeDurableTransfer(channel,{sessionId:'session',streamId:'objects',verifySession:async()=>({sessionId:'session'}),framing,sha256,inbox:{stage:async()=>{},applied:async()=>{}},cursorFor:async()=>({expectedCursor:null,cursor:'c'}),onReceipt:async()=>{},onError:()=>{}}),pending=[];
 const immediateError=promise=>Promise.race([promise.then(()=>'accepted',error=>error.message),new Promise(resolve=>setImmediate(()=>resolve('still queued')))]);
 try{block=true;for(let i=0;i<framing.MAX_TRANSFERS;i++)pending.push(transfer.send(`transfer-${i}`,Uint8Array.of(i)));
  assert.equal(await immediateError(transfer.send('oversized',new Uint8Array(framing.MAX_OBJECT+1))),'TOO_LARGE');
  assert.equal(await immediateError(transfer.send('overflow',new Uint8Array())),'TOO_LARGE');
  assert.equal(await immediateError(transfer.send('invalid','text')),'MALFORMED');
 }finally{block=false;release();await Promise.allSettled(pending)}
 await transfer.send('recovered',Uint8Array.of(9));
 channel.readyState='closed';await assert.rejects(transfer.send('channel-error',Uint8Array.of(1)),/CLOSED/);channel.readyState='open';await transfer.send('after-error',Uint8Array.of(2));transfer.close();
});
