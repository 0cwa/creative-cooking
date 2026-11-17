import test from 'node:test';
import assert from 'node:assert/strict';
import {cookingFiles} from './cooking-file.mjs';
import {MAX_OBJECT} from '../transport/adapter.mjs';
test('retained updates distinguish policy evidence and other retry reasons',async()=>{
 const ok=value=>({ok:true,value}),storage={listCursors:async()=>ok([{source:'file:one',cursor:'one'},{source:'file:two',cursor:'two'},{source:'relay',cursor:'three'}]),listStagedInbox:async()=>ok([{itemId:'one',bytes:new Uint8Array([1])},{itemId:'two',bytes:new Uint8Array([2])},{itemId:'three',bytes:new Uint8Array([3])}]),listDisclosurePending:async()=>ok([{objectId:'one',reason:'POLICY_GOVERNANCE_UNPROVEN'}]),getInboxApplication:async()=>ok(null)};
 const api=cookingFiles({runtime:{scope:{scopeId:'s'},storage},service:{}});assert.deepEqual(await api.pending(),[{itemId:'one',reason:'POLICY_GOVERNANCE_UNPROVEN'},{itemId:'two',reason:null}]);
});
test('oversized input is rejected before authorization or copying',async()=>{
 let calls=0;const api=cookingFiles({runtime:{scope:{scopeId:'s'},authorization:async()=>{calls++;throw Error('unexpected') }},service:{}});await assert.rejects(()=>api.receive(new Uint8Array(MAX_OBJECT+1)),/TOO_LARGE/);assert.equal(calls,0);
});
