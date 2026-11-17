import {RTCPeerConnection,RTCSessionDescription} from 'react-native-webrtc';
import {nativeEncryptedObjectChannel} from './compat-root/native/direct-transport.mjs';
import {exportFile,importFile,MAX_FRAME} from './compat-root/transport/adapter.mjs';
const gather=p=>new Promise((resolve,reject)=>{if(p.iceGatheringState==='complete')return resolve();const timer=setTimeout(()=>reject(Error('ICE gathering timeout')),20000);p.onicegatheringstatechange=()=>{if(p.iceGatheringState==='complete'){clearTimeout(timer);resolve()}}});
export async function directProof(w){
 const a=new RTCPeerConnection({iceServers:[]}),b=new RTCPeerConnection({iceServers:[]});let left,right,timer;
 try {
  const objects=(await w.household.storage.listOutboundObjects(w.household.scope.scopeId)).value,source=objects[0];if(!source)throw Error('missing outbound');const bytes=exportFile({id:source.objectId,bytes:source.bytes});if(bytes.length>MAX_FRAME)throw Error('TOO_LARGE');
  const auth=await w.household.authorization();let resolveMessage,rejectMessage;const got=new Promise((resolve,reject)=>{resolveMessage=resolve;rejectMessage=reject;});timer=setTimeout(()=>rejectMessage(Error('direct timeout')),20000);
  b.ondatachannel=e=>{right=nativeEncryptedObjectChannel(e.channel,{onError:rejectMessage,verifyObject:async bytes=>(await w.household.codec.openContent(bytes,auth.signingKeyRefs)).object,onObject:async object=>{if(object.id!==source.objectId)throw Error('INVALID_PROOF');resolveMessage(true)}})};
  const channel=a.createDataChannel('encrypted-object');const ready=new Promise((resolve,reject)=>{channel.onopen=resolve;channel.onerror=reject});
  await a.setLocalDescription(await a.createOffer());await gather(a);await b.setRemoteDescription(new RTCSessionDescription(a.localDescription));await b.setLocalDescription(await b.createAnswer());await gather(b);await a.setRemoteDescription(new RTCSessionDescription(b.localDescription));
  await ready;left=nativeEncryptedObjectChannel(channel,{verifyObject:async bytes=>(await w.household.codec.openContent(bytes,auth.signingKeyRefs)).object,onObject:async()=>{},onError:rejectMessage});await left.send({id:source.objectId,bytes:source.bytes});await got;return 'PASS authenticated binary direct channel (two local native peers)';
 }finally{clearTimeout(timer);left?.close();right?.close();a.close();b.close()}
}
