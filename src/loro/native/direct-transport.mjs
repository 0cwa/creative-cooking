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
