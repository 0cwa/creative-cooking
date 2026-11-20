import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchProviderRequest} from './request-boundary.mjs';

test('each final serialized request is reviewed without revealing credentials',async()=>{
 const requests=[],sent=[],fetcher=async(url,options)=>{sent.push({url,...options});return new Response('ok')};
 const dispatch=async(request,send)=>{requests.push(request);assert.deepEqual(Object.keys(request),['endpoint','model','body']);assert.equal(Object.isFrozen(request),true);return send()};
 const common={endpoint:'http://127.0.0.1:1234/chat',model:'model',headers:{Authorization:'secret'},dispatch,fetcher};
 const first='{"messages":["pantry"]}',followup='{"messages":["pantry","tool result"]}';
 await dispatchProviderRequest({...common,body:first});await dispatchProviderRequest({...common,body:followup});
 assert.deepEqual(requests.map(x=>x.body),[first,followup]);assert.deepEqual(sent.map(x=>x.body),[first,followup]);assert.equal(sent[0].redirect,'manual');assert.equal(sent[0].credentials,'omit');assert.equal(requests[0].headers,undefined);
});
test('a rejected review cannot send and a review cannot replay the transport closure',async()=>{
 let calls=0;const args={endpoint:'http://127.0.0.1:1234/chat',model:'m',body:'{}',headers:{},fetcher:async()=>{calls++;return new Response('ok')}};
 await assert.rejects(()=>dispatchProviderRequest({...args,dispatch:async()=>{throw Error('DECLINED')}}),/DECLINED/);assert.equal(calls,0);
 await dispatchProviderRequest({...args,dispatch:async(_request,send)=>{const response=await send();assert.throws(()=>send(),/REQUEST_ALREADY_DISPATCHED/);return response}});assert.equal(calls,1);
});
