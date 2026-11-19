import {test} from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import {domain} from '../authority/validator.mjs';
import {existingRecipientContextBytes} from '../authority/ceremony.mjs';
import {ceremonyBytes} from './candidate-v2.mjs';
import {durableSession} from './durable-session.mjs';
import {prepareEstablishedOwnDeviceFanout,sealEstablishedOwnDeviceFile,withOpenedEstablishedOwnDeviceFile} from './household-own-device-established-file.mjs';
import {ownDeviceRecipientSignal,verifyOwnDeviceRecipients} from './household-own-device-recipients.mjs';
await sodium.ready;
const hex=b=>sodium.to_hex(b);
function store(){const rows=new Map();return {transaction(fn){const copy=structuredClone(rows),result=fn({get:k=>copy.get(k),put:(k,v)=>copy.set(k,structuredClone(v))});rows.clear();for(const [k,v] of copy)rows.set(k,v);return result}}}
test('own-device recipient proofs bind every established recipient to the signed successor',async()=>{
 const keys=Object.fromEntries(['A','B','C','X'].map(id=>[id,{sign:sodium.crypto_sign_keypair(),box:sodium.crypto_box_keypair()}]));
 const provider={hash:async b=>sodium.crypto_generichash(32,b),verify:async(ref,b,s)=>sodium.crypto_sign_verify_detached(s,b,sodium.from_hex(ref))};
 const parent={head:'parent',householdId:'home',devices:['A','B','C'].map(deviceId=>({deviceId,active:true,signingKeyRef:hex(keys[deviceId].sign.publicKey)})),runtime:{acceptedRecipients:['A','B','C']}};
 const event={kind:'pairOwnDevice',parentHead:parent.head,householdId:'home',authorDeviceId:'A',epochId:'epoch',subject:{deviceId:'N',parentSnapshot:'snapshot',copyHash:'ab'.repeat(32)}};
 const head=hex(await provider.hash(domain('event',event))),successor={head,item:{event}},scope={kind:'household',id:'home'};
 function evidence(recipient,opts={}){
  const sponsor=opts.sponsor??'A',signer=opts.signer??recipient,context={version:1,householdId:'home',parentHead:opts.parent??parent.head,admissionEventHash:opts.eventHash??head,newEpochId:event.epochId,sponsorDeviceId:sponsor,recipientDeviceId:recipient,recipientWrappingKey:hex(keys[recipient].box.publicKey)};
  const role=(role,id,signId=id)=>({role,deviceId:id,signingPublicKey:keys[signId].sign.publicKey,wrappingPublicKey:keys[id].box.publicKey,nonce:sodium.randombytes_buf(32)});
  const transcript={version:1,sessionId:`${sponsor}-${recipient}-${signer}`,action:opts.action??'pairOwnDevice',scope,purpose:'data',acceptedParent:parent.head,authorizationSnapshot:'snapshot',initiator:role('initiator',sponsor),responder:role('responder',recipient,signer),signaling:[existingRecipientContextBytes(context),ownDeviceRecipientSignal(opts.signalHead??head,opts.copyHash??event.subject.copyHash,event.epochId)]};
  const guard={version:1,guardId:transcript.sessionId,scope,direction:'initiator-to-responder',purpose:'data'},oob={hash:hex(sodium.crypto_generichash(32,ceremonyBytes(transcript,guard))),pins:Object.fromEntries(['initiator','responder'].map(r=>[r,{deviceId:transcript[r].deviceId,signingKey:hex(transcript[r].signingPublicKey),wrappingKey:hex(transcript[r].wrappingPublicKey)}]))};
  const open=(r,id,signId=id)=>durableSession(sodium,store(),{signingSecret:keys[signId].sign.privateKey,wrappingSecret:keys[id].box.privateKey},transcript,guard,r,oob),a=open('initiator',sponsor),b=open('responder',recipient,signer),ao=a.initialize(),bo=b.initialize(),ar=a.respond(bo,0),br=b.respond(ao,0),aa=a.acknowledge(br,1),ba=b.acknowledge(ar,1);a.finish(ba,2);b.finish(aa,2);
  return {transcript,guard,oob,messages:a.evidence().messages,context};
 }
 const verify=evidence=>verifyOwnDeviceRecipients({sodium,provider,successor,parent,authorizationSnapshot:'snapshot',evidence}),b=evidence('B'),c=evidence('C');
 await assert.rejects(verifyOwnDeviceRecipients({sodium,provider,successor,parent:{...parent,head:'different'},authorizationSnapshot:'snapshot',evidence:[b,c]}));
 const recipients=await verify([c,b]);
 assert.deepEqual(recipients.map(x=>x.deviceId),['B','C']);
 const context={version:1,transcriptHash:b.oob.hash,releaseId:'session',scopeKind:'household',scopeId:'home',purpose:'data',epochId:'epoch',generation:1,
  senderDevice:'A',senderSigningKey:hex(keys.A.sign.publicKey),senderWrappingKey:hex(keys.A.box.publicKey),recipientDevice:'N',recipientSigningKey:hex(keys.X.sign.publicKey),recipientWrappingKey:hex(keys.X.box.publicKey),policyHash:'policy',grantHash:head,projectionId:'doc1',manifestHash:event.subject.copyHash};
 const checked={head,context,documents:[{targetDocumentId:'doc1',copy:'one'},{targetDocumentId:'doc2',copy:'two'}]};
 const documentKeys=new Map(checked.documents.map(d=>[d.targetDocumentId,sodium.randombytes_buf(32)]));
 const files=[];
 for(const [i,ev] of [b,c].entries())files.push(await sealEstablishedOwnDeviceFile({sodium,provider,checked,recipient:recipients[i],evidence:ev,signingSecret:keys.A.sign.privateKey,withDocumentKey:(id,fn)=>fn(documentKeys.get(id))}));
 const fanout=await prepareEstablishedOwnDeviceFanout({sodium,provider,checked:{...checked,item:successor.item},parent,authorizationSnapshot:'snapshot',evidence:[c,b],signingSecret:keys.A.sign.privateKey});
 const packetRows=checked.documents.map(d=>fanout.packetFor(checked.documents.indexOf(d),documentKeys.get(d.targetDocumentId)));
 const fanoutFiles=fanout.seal(packetRows);
 assert.deepEqual(fanoutFiles.map(x=>x.recipient.deviceId),['B','C']);
 for(const [i,ev] of [b,c].entries())await withOpenedEstablishedOwnDeviceFile({sodium,provider,checked,recipient:recipients[i],evidence:ev,file:fanoutFiles[i].file,wrappingSecret:keys[ev.context.recipientDeviceId].box.privateKey,withKeys:ks=>assert.deepEqual(ks.map(x=>hex(x.key)),checked.documents.map(d=>hex(documentKeys.get(d.targetDocumentId))))});
 await assert.rejects(prepareEstablishedOwnDeviceFanout({sodium,provider,checked:{...checked,item:successor.item},parent,authorizationSnapshot:'snapshot',evidence:[b],signingSecret:keys.A.sign.privateKey}));
 assert.throws(()=>fanout.seal(packetRows.slice(1)));
 const opened=[];
 for(const [i,ev] of [b,c].entries())await withOpenedEstablishedOwnDeviceFile({sodium,provider,checked,recipient:recipients[i],evidence:ev,file:files[i],wrappingSecret:keys[ev.context.recipientDeviceId].box.privateKey,withKeys:ks=>opened.push(ks.map(x=>hex(x.key)))});
 assert.deepEqual(opened[0],opened[1]);assert.notEqual(opened[0][0],opened[0][1]);
 const open=(file,recipient=recipients[0],ev=b,view=checked)=>withOpenedEstablishedOwnDeviceFile({sodium,provider,checked:view,recipient,evidence:ev,file,wrappingSecret:keys[ev.context.recipientDeviceId].box.privateKey,withKeys:()=>assert.fail('unexpected keys')});
 await assert.rejects(open(files[0],recipients[1],c));
 const tampered=files[0].slice();tampered[tampered.length-1]^=1;await assert.rejects(open(tampered));
 await assert.rejects(open(files[0],recipients[0],b,{...checked,documents:[{...checked.documents[0],copy:'changed'},checked.documents[1]]}));
 await assert.rejects(open(files[0],recipients[0],b,{...checked,head:'changed'}));
 for(const bad of [[b],[b,c,c],[evidence('B',{copyHash:'cd'.repeat(32)}),c],[evidence('B',{eventHash:'ef'.repeat(32)}),c],[evidence('B',{signalHead:'ef'.repeat(32)}),c],[evidence('B',{parent:'wrong'}),c],[evidence('B',{sponsor:'C'}),c],[evidence('B',{signer:'X'}),c],[evidence('B',{action:'inviteAdult'}),c]])await assert.rejects(verify(bad));
});
