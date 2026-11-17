import {verifyHouseholdSessionEvidence} from '../pairing/durable-session.mjs';
import {MAX_FRAME,MAX_QUEUED_FRAMES,sendFrames} from '../transport/adapter.mjs';
/** Binary channel bridge. Callers must authenticate signaling and verify received frames. */
export function nativeBinaryChannel(channel,{onFrame,onError}) {
 if(!channel||typeof channel.addEventListener!=='function'||typeof onFrame!=='function'||typeof onError!=='function')throw Error('MALFORMED');
 let queue=Promise.resolve(),queued=0,closed=false;
 const message=event=>{
  if(closed)return;const data=event.data;let bytes;
  if(data instanceof ArrayBuffer)bytes=new Uint8Array(data);else if(ArrayBuffer.isView(data))bytes=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);else {onError(Error('MALFORMED'));return}
  if(bytes.byteLength>MAX_FRAME||queued>=MAX_QUEUED_FRAMES){onError(Error('TOO_LARGE'));return}
  const snapshot=new Uint8Array(bytes);queued++;const next=queue.then(()=>onFrame(snapshot));queue=next.catch(error=>{onError(error)}).finally(()=>{queued--});
 };
 channel.addEventListener('message',message);
 return {send:async frame=>{if(closed)throw Error('CLOSED');if(!(frame instanceof Uint8Array)||frame.length>MAX_FRAME)throw Error('TOO_LARGE');await sendFrames(channel,[new Uint8Array(frame)])},close:()=>{if(closed)return;closed=true;channel.removeEventListener('message',message)}};
}
/** Small encrypted objects only. Authentication and durable inbox staging stay with the caller. */
export function nativeEncryptedObjectChannel(channel,{verifyObject,onObject,onError}) {
 if(typeof verifyObject!=='function'||typeof onObject!=='function')throw Error('MALFORMED');
 const bridge=nativeBinaryChannel(channel,{onError,onFrame:async frame=>{const {importFile}=await import('../transport/adapter.mjs');const input=importFile(frame),verified=await verifyObject(new Uint8Array(input.bytes));if(!verified||verified.id!==input.id||!(verified.bytes instanceof Uint8Array)||verified.bytes.length!==input.bytes.length||verified.bytes.some((b,i)=>b!==input.bytes[i]))throw Error('INVALID_PROOF');await onObject(input)}});
 return {send:async object=>{const {exportFile}=await import('../transport/adapter.mjs');const frame=exportFile(object);if(frame.length>MAX_FRAME)throw Error('TOO_LARGE');await bridge.send(frame)},close:bridge.close};
}

/**
 * Build a bounded encrypted transfer on an independently authenticated channel.
 * `framing` must expose the shared injectable-digest API and `inbox` must be
 * the shared inboxAdapter. A fresh transfer ID is required when retrying a
 * completed transfer whose receipt was lost.
 */
export async function nativeDurableTransfer(channel,{sessionId,streamId,verifySession,framing,sha256,inbox,cursorFor,onReceipt,onError}) {
 if(typeof sessionId!=='string'||!sessionId||typeof streamId!=='string'||!streamId||typeof verifySession!=='function'||typeof sha256!=='function'||typeof framing?.objectFrames!=='function'||typeof framing?.Reassembler!=='function'||typeof inbox?.stage!=='function'||typeof inbox?.applied!=='function'||typeof cursorFor!=='function'||typeof onReceipt!=='function'||typeof onError!=='function')throw Error('MALFORMED');
 const verified=await verifySession();if(!verified||verified.sessionId!==sessionId)throw Error('INVALID_PROOF');
 if(await sha256(new Uint8Array())!=='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')throw Error('INVALID_PROOF');
 // Refuse an older framing implementation that silently ignores injection.
 const zero='0'.repeat(64);let probe;try{probe=await framing.objectFrames({sessionId,streamId,transferId:'native-framing-probe',bytes:new Uint8Array()},async()=>zero)}catch{throw Error('FRAMING_UNAVAILABLE')}
 let header;try{header=JSON.parse(new TextDecoder().decode(probe[0]))}catch{throw Error('FRAMING_UNAVAILABLE')}
 if(probe.length!==1||header.payloadHash!==zero)throw Error('FRAMING_UNAVAILABLE');
 const probeReceiver=new framing.Reassembler(sessionId,MAX_FRAME,async()=>zero);let checked;try{checked=await probeReceiver.accept(probe[0])}catch{throw Error('FRAMING_UNAVAILABLE')}if(!checked||checked.bytes.length)throw Error('FRAMING_UNAVAILABLE');
 const receiver=new framing.Reassembler(sessionId,MAX_FRAME,sha256);let sendQueue=Promise.resolve(),closed=false;
 const bridge=nativeBinaryChannel(channel,{onError,onFrame:async frame=>{if(closed)throw Error('CLOSED');const object=await receiver.accept(frame);if(!object)return;if(object.streamId!==streamId)throw Error('SESSION');const cursors=await cursorFor(object.transferId);if(!cursors||typeof cursors.cursor!=='string'||!(cursors.expectedCursor===null||typeof cursors.expectedCursor==='string'))throw Error('MALFORMED');const receipt=await inbox.stage({transferId:object.transferId,bytes:object.bytes,expectedCursor:cursors.expectedCursor,cursor:cursors.cursor});await onReceipt(receipt)}});
 return {
  send:(transferId,bytes)=>{if(closed)return Promise.reject(Error('CLOSED'));const payload=bytes instanceof Uint8Array?new Uint8Array(bytes):bytes;const run=sendQueue.then(async()=>{if(closed)throw Error('CLOSED');const frames=await framing.objectFrames({sessionId,streamId,transferId,bytes:payload},sha256);await sendFrames(channel,frames)});sendQueue=run.catch(()=>{});return run},
  applied:(objectId,transferId)=>inbox.applied(objectId,transferId),
  close:()=>{closed=true;bridge.close()},
 };
}

/** Bind signed household ceremony evidence to the actual negotiated signaling.
 * The authority callback must verify current pinned authority and guard consumption.
 */
export function householdDirectVerifier({sodium,transcript,guard,oob,messages,context,verifyNegotiated,authorize}) {
 if(!sodium||typeof verifyNegotiated!=='function'||typeof authorize!=='function')throw Error('MALFORMED');
 const t=structuredClone(transcript),g=structuredClone(guard),o=structuredClone(oob),m=structuredClone(messages),c=structuredClone(context);
 return async()=>{const proof=verifyHouseholdSessionEvidence(sodium,t,g,o,m,c);if(t.signaling.length<2)throw Error('INVALID_PROOF');if(!await verifyNegotiated(t.signaling.slice(1).map(x=>new Uint8Array(x)))||!await authorize(proof))throw Error('INVALID_PROOF');return {...proof,sessionId:t.sessionId}};
}
