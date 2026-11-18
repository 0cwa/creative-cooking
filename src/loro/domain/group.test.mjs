import {test} from 'node:test'; import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite'; import {mkdtempSync,rmSync} from 'node:fs'; import {join} from 'node:path'; import sodium from 'libsodium-wrappers';
import {tmpdir} from 'node:os';
import {LoroDoc,decodeImportBlobMeta} from 'loro-crdt/nodejs';
import {openSQLiteStorage} from '../storage/sqlite.ts'; import {rootPin,policyId,initializeAuthority,resolveRuntimeAuthority} from '../authority/chain.mjs';
import {personalRootPin,initializePersonalAuthority,resolvePersonalAuthority} from '../authority/personal.mjs'; import {domain} from '../authority/validator.mjs';
import {candidateCodec} from '../crypto/candidate.mjs'; import {testProvider} from '../crypto/test-provider.mjs';
import {proposalMapName} from './registry.mjs'; import {OfflineRuntime} from '../engine/runtime.mjs'; import {acceptChef} from './chef.mjs';
await sodium.ready;
test('Chef group rollback, lost acknowledgement, and replay with separately pinned scopes',async()=>{
 const pair=sodium.crypto_sign_keypair(), recipient=sodium.crypto_box_keypair(); const provider={hash:async b=>sodium.crypto_generichash(32,b),verify:async(k,b,s)=>sodium.crypto_sign_verify_detached(s,b,pair.publicKey)};
 const dir=mkdtempSync(join(tmpdir(),'loro-group-test-')); let db;let faultAt=0,writes=0,storage; const open=()=>{db=new DatabaseSync(join(dir,'group.sqlite'));const conn={executeSync:(sql,args=[])=>{const s=db.prepare(sql);return {rows:sql.startsWith('SELECT')?s.all(...args):(s.run(...args),[])}}};storage=openSQLiteStorage(conn,b=>{if(b==='write' && ++writes===faultAt)throw Error('injected')})};open();
 const policy={kind:'allMinusOne',fixedCount:null};const root={householdId:'house',head:'',policyHash:await policyId(provider,policy),generation:1,epochId:'epoch',roster:['a'],devices:[{adultId:'a',deviceId:'a',signingKeyRef:'a',active:true}],policy,runtime:{documentId:'house-doc',authorPeers:{a:'1'},acceptedRecipients:['a']}};root.head=await rootPin(provider,root);
 const pr={version:1,suiteId:'candidate-ed25519-xchacha20-sealedbox-v1',scopeId:'private',ownerId:'a',signerDeviceId:'a',devices:[{deviceId:'a',ownerId:'a',signingKeyRef:'a',peerId:'2',active:true}],documentId:'personal-doc',generation:1,epochId:'personal-epoch'};const pin=await personalRootPin(provider,pr);const signature=Buffer.from(sodium.crypto_sign_detached(domain('personal-root-signature',pr),pair.privateKey)).toString('hex');
 try {await initializeAuthority(storage,root,root.head,provider); await initializePersonalAuthority(storage,{kind:'personal',id:'private'},pin,provider,{version:1,root:pr,signature});
 const hs=await resolveRuntimeAuthority(storage,{kind:'household',id:'house'},root.head,provider,'a'),ps=await resolvePersonalAuthority(storage,{kind:'personal',id:'private'},pin,provider,'a');let seals=0; const keys={personal:sodium.randombytes_buf(32),household:sodium.randombytes_buf(32)};
 const runtime=(resolved,kind,pin)=>{const cp=testProvider(sodium,{signing:pair,publicSigning:pair.publicKey,recipient,publicRecipient:recipient.publicKey,initialKey:keys[kind]});cp.sign=async(w,b)=>sodium.crypto_sign_detached(b,pair.privateKey);cp.verify=async(w,b,s)=>sodium.crypto_sign_verify_detached(s,b,pair.publicKey);const real=candidateCodec(cp);const codec={...real,sealContent:async(...args)=>{seals++;return real.sealContent(...args)}};return new OfflineRuntime({storage,codec,LoroDoc,decodeImportBlobMeta,scope:resolved.scope,keyRef:'data',authority:{kind,rootPin:pin,provider}})};
 let personal=runtime(ps,'personal',pin), household=runtime(hs,'household',root.head);
 const create={version:1,kind:'chef-proposal-create',commandId:'create',effectId:'create-effect',dependencyEffectIds:[],data:{conversationId:'secret-conversation',proposalId:'secret-proposal',toolName:'pantry_add',arguments:'{"names":["carrot"]}',status:'pending',createdAt:'2026-01-01T00:00:00Z'}};
 const argsFor=()=>({storage,groupId:'group',personal,household,conversationId:'secret-conversation',proposalId:'secret-proposal',personalOperationId:'personal-op',householdOperationId:'house-op',personalCommandId:'pc',personalEffectId:'pe',householdCommandId:'hc',householdEffectId:'he',personalSequence:2,householdSequence:1});
 await assert.rejects(acceptChef(argsFor()),/PROPOSAL_NOT_PENDING/);
 await assert.rejects(acceptChef({...argsFor(),householdInput:{command:'caller-selected'}}),/MALFORMED/);
 await personal.execute({operationId:'create-op',deviceSequence:1,command:create});
 const otherDb=new DatabaseSync(':memory:');
 try {
  const other=openSQLiteStorage({executeSync:(sql,args=[])=>{const s=otherDb.prepare(sql);return {rows:sql.startsWith('SELECT')?s.all(...args):(s.run(...args),[])}}});
  await initializeAuthority(other,root,root.head,provider);
  await initializePersonalAuthority(other,{kind:'personal',id:'private'},pin,provider,{version:1,root:pr,signature});
  const onOther=runtime=>new OfflineRuntime({storage:other,codec:runtime.codec,LoroDoc,decodeImportBlobMeta,scope:runtime.scope,keyRef:runtime.keyRef,authority:runtime.authority});
  const beforeMismatch=seals;
  await assert.rejects(acceptChef({...argsFor(),household:onOther(household)}),/STORAGE_MISMATCH/);
  await assert.rejects(acceptChef({...argsFor(),personal:onOther(personal)}),/STORAGE_MISMATCH/);
  assert.equal(seals,beforeMismatch);
  assert.equal((await storage.getLocalGroup('group')).value,null);
  assert.equal((await storage.reopenDocument('house','house-doc')).value,null);
  assert.equal((await other.reopenDocument('house','house-doc')).value,null);
  assert.equal((await storage.reopenDocument('private','personal-doc')).value.revision,0);
 } finally {otherDb.close();}
 let args=argsFor();
 // A substituted read cannot bind a different proposal to the durable one.
 const readDocument=personal.document.bind(personal);let substitute=true;
 personal.document=async()=>{const result=await readDocument();if(substitute){substitute=false;const m=result.doc.getMap(proposalMapName('secret-conversation','secret-proposal'));m.set('proposal',{...m.get('proposal'),arguments:'{"names":["poison"]}'});}return result};
 const beforeTamper=seals;await assert.rejects(acceptChef(args),/CONFLICT/);assert.equal(seals,beforeTamper);assert.equal((await storage.getLocalGroup('group')).value,null);personal.document=readDocument;

 // Fail each SQL write in turn until the transaction completes; failed attempts
 // must leave both scope documents and the group absent.
 let succeeded=false; for(let i=1;i<=30;i++){writes=0;faultAt=i;try {await acceptChef(args); succeeded=true;break;}catch(e){assert.equal(e.message,'IO');faultAt=0;assert.equal((await storage.reopenDocument('private','personal-doc')).value.revision,0);assert.equal((await storage.reopenDocument('house','house-doc')).value,null);assert.equal((await storage.getLocalGroup('group')).value,null)}}
 assert.equal(succeeded,true);faultAt=0;db.close();open();personal=runtime(ps,'personal',pin);household=runtime(hs,'household',root.head);args={...args,storage,personal,household};const before=seals;const retry=await acceptChef(args);assert.equal(retry.replayed,true);assert.equal(seals,before);
 const saved=(await storage.getLocalGroup('group')).value;assert.equal(saved.group.children.length,2);const decoded=await household.codec.openContent(saved.group.children[1].outbound[0].object.bytes);assert.equal(new TextDecoder().decode(decoded.value).includes('secret-proposal'),false);
 await assert.rejects(acceptChef({...args,proposalId:'different'}),/CONFLICT/);
 await assert.rejects(acceptChef({...args,groupId:'another'}),/PROPOSAL_NOT_PENDING/);
 const recipeProposal={...create,commandId:'recipe-create',effectId:'recipe-create-effect',data:{...create.data,proposalId:'recipe-private',toolName:'recipe_save',arguments:JSON.stringify({title:'Soup',portions:2,ingredients:[{name:'Carrot',amount:'2'}],steps:['Chop','Cook']})}};
 await personal.execute({operationId:'recipe-create-op',deviceSequence:3,command:recipeProposal});
 const recipeArgs={...args,groupId:'recipe-group',proposalId:'recipe-private',personalOperationId:'recipe-p',householdOperationId:'recipe-h',personalCommandId:'rpc',personalEffectId:'rpe',householdCommandId:'rhc',householdEffectId:'rhe',personalSequence:4,householdSequence:2};
 await acceptChef(recipeArgs);
 const recipeCommit=(await storage.getLocalGroup('recipe-group')).value.group.children[1];
 const recipePayload=JSON.parse(new TextDecoder().decode((await household.codec.openContent(recipeCommit.outbound[0].object.bytes)).value));
 const values=recipePayload.command.data.mutations;assert.ok(values.some(x=>x.field==='title' && x.value==='Soup'));assert.ok(values.some(x=>x.field==='ingredients' && x.value[0].id));assert.ok(values.some(x=>x.field==='stepIds' && x.value.length===2));assert.equal(JSON.stringify(recipePayload).includes('recipe-private'),false);
 const recipeId=values.find(x=>x.field==='title').id,ingredientId=values.find(x=>x.field==='ingredients').value[0].id;
 const edit={version:1,kind:'recipe-ingredient-field',commandId:'edit',effectId:'edit',dependencyEffectIds:['rhe'],data:{recipeId,ingredientId,field:'amount',value:'3',author:'a',at:'2026-01-01T00:00:00Z'}};
 await household.execute({operationId:'edit-op',deviceSequence:3,command:edit});
 const add={version:1,kind:'recipe-step-add',commandId:'add',effectId:'add',dependencyEffectIds:['rhe'],data:{recipeId,stepId:'new-step',text:'Serve',position:2,author:'a',at:'2026-01-01T00:00:00Z'}};
 await household.execute({operationId:'add-op',deviceSequence:4,command:add});
 const reopened=await household.document(),member=JSON.stringify([recipeId,ingredientId]);assert.equal(reopened.doc.getMap(`recipe-ingredient:${encodeURIComponent(member)}`).get('amount'),'3');assert.equal(reopened.doc.getMap(`recipe-step-index:${encodeURIComponent(recipeId)}`).get('new-step'),'add');
 const lostProposal={...create,commandId:'lost-create',effectId:'lost-create',data:{...create.data,proposalId:'lost',arguments:'{\"names\":[\"ginger\"]}'}};await personal.execute({operationId:'lost-create',deviceSequence:5,command:lostProposal});
 const lostArgs={...args,groupId:'lost-group',proposalId:'lost',personalOperationId:'lost-p',householdOperationId:'lost-h',personalCommandId:'lpc',personalEffectId:'lpe',householdCommandId:'lhc',householdEffectId:'lhe',personalSequence:6,householdSequence:5},realCommit=storage.commitLocalGroup.bind(storage);
 storage.commitLocalGroup=async group=>{const result=await realCommit(group);if(result.ok)throw Error('lost acknowledgement');return result};await assert.rejects(acceptChef(lostArgs),/lost acknowledgement/);storage.commitLocalGroup=realCommit;const afterLost=seals;assert.equal((await acceptChef(lostArgs)).replayed,true);assert.equal(seals,afterLost);const lostCommand=JSON.parse(new TextDecoder().decode((await storage.getLocalGroup('lost-group')).value.group.children[1].commands[0].payload));assert.ok(lostCommand.dependencyEffectIds.includes('he'));assert.equal(lostCommand.dependencyEffectIds.includes('rhe'),false);assert.equal(lostCommand.dependencyEffectIds.includes('edit'),false);
 const staleProposal={...create,commandId:'stale-create',effectId:'stale-create',data:{...create.data,proposalId:'stale',arguments:'{"names":["onion"]}'}};await personal.execute({operationId:'stale-create',deviceSequence:7,command:staleProposal});
 const pBefore=(await storage.reopenDocument('private','personal-doc')).value,hBefore=(await storage.reopenDocument('house','house-doc')).value,authority=(await storage.readPairingAuthority({kind:'household',id:'house'})).value,commitGroup=storage.commitLocalGroup.bind(storage);
 storage.commitLocalGroup=async group=>{assert.equal((await storage.compareAndSwapPairingAuthority({expectedRevision:authority.revision,record:{...authority,revision:authority.revision+1}})).ok,true);return commitGroup(group)};
 await assert.rejects(acceptChef({...args,groupId:'stale-group',proposalId:'stale',personalOperationId:'stale-p',householdOperationId:'stale-h',personalCommandId:'spc',personalEffectId:'spe',householdCommandId:'shc',householdEffectId:'she',personalSequence:8,householdSequence:6}),/CONFLICT/);
 storage.commitLocalGroup=commitGroup;assert.deepEqual((await storage.reopenDocument('private','personal-doc')).value,pBefore);assert.deepEqual((await storage.reopenDocument('house','house-doc')).value,hBefore);assert.equal((await storage.getLocalGroup('stale-group')).value,null);



 const nextArgs=(name,proposalId,personalSequence,householdSequence)=>({...args,groupId:name,proposalId,personalOperationId:name+'-p',householdOperationId:name+'-h',personalCommandId:name+'-pc',personalEffectId:name+'-pe',householdCommandId:name+'-hc',householdEffectId:name+'-he',personalSequence,householdSequence});
 const pantryDoc=(await household.document()).doc,carrotId=Object.keys(pantryDoc.getMap('pantry-index').toJSON()).find(id=>pantryDoc.getMap(`pantry:${encodeURIComponent(id)}`).get('name')?.toLocaleLowerCase()==='carrot');assert.ok(carrotId);
 await household.execute({operationId:'remove-carrot',deviceSequence:6,command:{version:1,kind:'pantry-field',commandId:'remove-carrot',effectId:'remove-carrot',dependencyEffectIds:['he'],data:{itemId:carrotId,field:'removedAt',value:'2026-01-02T00:00:00Z',author:'a',at:'2026-01-02T00:00:00Z'}}});
 await personal.execute({operationId:'re-add-create',deviceSequence:8,command:{...create,commandId:'re-add-create',effectId:'re-add-create',data:{...create.data,proposalId:'re-add',arguments:'{"names":["Carrot"]}'}}});
 await acceptChef(nextArgs('re-add-group','re-add',9,7));
 const readded=(await household.document()).doc;assert.equal(readded.getMap(`pantry:${encodeURIComponent(carrotId)}`).get('removedAt'),'2026-01-02T00:00:00Z');
 const liveCarrots=Object.keys(readded.getMap('pantry-index').toJSON()).filter(id=>{const value=readded.getMap(`pantry:${encodeURIComponent(id)}`).toJSON();return value.name?.toLocaleLowerCase()==='carrot'&&!value.removedAt&&!value.removed});assert.equal(liveCarrots.length,1);assert.notEqual(liveCarrots[0],carrotId);
 // Seed the already accepted household settings through the real storage adapter.
 const settings=await household.document();settings.doc.setPeerId('1');settings.doc.getMap('settings').set('allergies',['peanut']);
 assert.equal((await storage.commitLocal({expectedAuthority:await household.authorize(),scopeId:'house',operationId:'settings-bootstrap',documents:[{documentId:'house-doc',bytes:settings.doc.export({mode:'snapshot'}),expectedRevision:settings.revision}],commands:[{version:1,commandId:'settings-bootstrap',effectId:'settings-bootstrap',documentId:'house-doc',kind:'fixture-settings',payload:new Uint8Array([1]),dependencyEffectIds:[]}],outbound:[]})).ok,true);
 await personal.execute({operationId:'allergy-create',deviceSequence:10,command:{...create,commandId:'allergy-create',effectId:'allergy-create',data:{...create.data,proposalId:'allergy',toolName:'recipe_save',arguments:JSON.stringify({title:'Peanut soup',portions:2,ingredients:[{name:'peanut',amount:'1'}],steps:['Mix']})}}});
 const beforeAllergy={personal:(await storage.reopenDocument('private','personal-doc')).value,household:(await storage.reopenDocument('house','house-doc')).value,seals};
 await assert.rejects(acceptChef(nextArgs('allergy-group','allergy',11,8)),/Recipe blocked by allergy validation/);
 assert.equal((await storage.getLocalGroup('allergy-group')).value,null);assert.equal(seals,beforeAllergy.seals);assert.deepEqual((await storage.reopenDocument('private','personal-doc')).value,beforeAllergy.personal);assert.deepEqual((await storage.reopenDocument('house','house-doc')).value,beforeAllergy.household);
 }finally{db.close();rmSync(dir,{recursive:true,force:true})}
});
