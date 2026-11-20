import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import sodium from 'libsodium-wrappers';
import {LoroDoc,decodeImportBlobMeta} from 'loro-crdt/nodejs';
import {openSQLiteStorage} from '../storage/sqlite.ts';
import {rootPin,policyId,initializeAuthority,resolveRuntimeAuthority} from '../authority/chain.mjs';
import {candidateCodec} from '../crypto/candidate.mjs';
import {testProvider} from '../crypto/test-provider.mjs';
import {OfflineRuntime} from '../engine/runtime.mjs';
await sodium.ready;
test('signed pinned household authority, real encryption and SQLite preparation',async()=>{
 const pair=sodium.crypto_sign_keypair(),recipient=sodium.crypto_box_keypair();
 const provider={hash:async b=>sodium.crypto_generichash(32,b),verify:async(k,b,s)=>sodium.crypto_sign_verify_detached(s,b,pair.publicKey)};
 const db=new DatabaseSync(':memory:'); const conn={executeSync:(sql,params=[])=>{const st=db.prepare(sql);return {rows:sql.startsWith('SELECT')?st.all(...params):(st.run(...params),[])}}}; const storage=openSQLiteStorage(conn);
 const policy={kind:'allMinusOne',fixedCount:null}; const root={householdId:'house',head:'',policyHash:await policyId(provider,policy),generation:1,epochId:'epoch',roster:['a'],devices:[{adultId:'a',deviceId:'a',signingKeyRef:'key-a',active:true}],policy,runtime:{documentId:'cooking',authorPeers:{a:'1'},acceptedRecipients:['a']}}; root.head=await rootPin(provider,root);
 try {await initializeAuthority(storage,root,root.head,provider);const resolved=await resolveRuntimeAuthority(storage,{kind:'household',id:'house'},root.head,provider,'a');
 const crypto=testProvider(sodium,{signing:pair,publicSigning:pair.publicKey,recipient,publicRecipient:recipient.publicKey,initialKey:sodium.randombytes_buf(32)});
 crypto.sign=async (who,bytes)=>{assert.equal(who,'key-a');return sodium.crypto_sign_detached(bytes,pair.privateKey)}; crypto.verify=async (who,bytes,sig)=>who==='key-a' && sodium.crypto_sign_verify_detached(sig,bytes,pair.publicKey);
 const runtime=new OfflineRuntime({storage,codec:candidateCodec(crypto),LoroDoc,decodeImportBlobMeta,scope:resolved.scope,keyRef:'data',authority:{rootPin:root.head,provider}});
 const command={version:1,kind:'recipe-create',commandId:'cmd',effectId:'effect',dependencyEffectIds:[],data:{recipe:{id:'r',title:'Soup',portions:2,ingredients:[],steps:[],stepIds:[]},author:'a',at:'2026-11-17T00:00:00Z'}};
 const prepared=await runtime.prepare({operationId:'op',command,deviceSequence:1}); assert.equal((await storage.reopenDocument('house','cooking')).value,null);
 assert.equal((await storage.commitLocal(prepared.commit)).ok,true); const saved=await storage.reopenDocument('house','cooking');const doc=new LoroDoc();doc.import(saved.value.bytes);assert.equal(doc.getMap('recipe:r').get('title'),'Soup');
 assert.equal((await runtime.prepare({operationId:'op',command,deviceSequence:1})).previous.replayed,true);
 const next={...command,commandId:'other',effectId:'other',data:{...command.data,recipe:{...command.data.recipe,id:'other'}}};const good=await runtime.prepare({operationId:'other',command:next,deviceSequence:2});const sealed=good.commit.outbound[0].object,opened=await runtime.codec.openContent(sealed.bytes,{a:'key-a'});const badKey=sodium.crypto_sign_keypair(),badCodec=candidateCodec({...crypto,sign:async (_,bytes)=>sodium.crypto_sign_detached(bytes,badKey.privateKey)});const forged=await badCodec.sealContent(opened.header,opened.value,'data','key-a');assert.equal((await storage.stageInbox({scopeId:'house',object:{id:forged.id,bytes:forged.bytes},source:'test',expectedCursor:null,cursor:'bad'})).ok,true);const beforeBad=(await runtime.document()).revision;await assert.rejects(runtime.importItem({itemId:forged.id,bytes:forged.bytes}),/INVALID_PROOF/);assert.equal((await runtime.document()).revision,beforeBad);assert.equal((await storage.getInboxApplication('house',forged.id)).value,null);

 const authority=(await storage.readPairingAuthority({kind:'household',id:'house'})).value;assert.equal((await storage.compareAndSwapPairingAuthority({expectedRevision:authority.revision,record:{...authority,revision:authority.revision+1}})).ok,true);assert.equal((await storage.commitLocal(good.commit)).error.code,'CONFLICT');assert.equal((await runtime.document()).revision,beforeBad);
 const ownerKey=JSON.stringify(['document-owner','house','cooking']);db.prepare('UPDATE loro_records SET value=? WHERE key=?').run(JSON.stringify('other-head'),ownerKey);
 await assert.rejects(runtime.document(),/CHECKOUT_REQUIRED/);
 await assert.rejects(runtime.prepare({operationId:'new-op',command:{...command,commandId:'new-cmd',effectId:'new-effect'},deviceSequence:2}),/CHECKOUT_REQUIRED/);
 assert.deepEqual((await storage.reopenDocument('house','cooking')).value.bytes,saved.value.bytes);
 }finally{db.close()}
});
