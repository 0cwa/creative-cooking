import {fixture,chunks,Receiver,send,bundle,unbundle} from './transport.mjs';
const $=id=>document.getElementById(id), log=x=>{$('log').textContent+=JSON.stringify(x)+'\n';};
let pc, channel; const receiver=new Receiver();
function init(){if(pc)pc.close(); pc=new RTCPeerConnection({iceServers:[]}); pc.ondatachannel=e=>attach(e.channel); return pc;}
function attach(c){channel=c; c.binaryType='arraybuffer'; c.onopen=()=>log({channel:'open'}); c.onmessage=e=>{try{if(typeof e.data==='string'){log(JSON.parse(e.data));return;} const obj=receiver.accept(new Uint8Array(e.data)); if(obj){log({received:obj.id,bytes:[...obj.bytes]});c.send(JSON.stringify({receipt:'received-in-memory',id:obj.id}));}}catch(error){log({error:String(error)});}};}
async function gathered(){if(pc.iceGatheringState==='complete')return; await new Promise(resolve=>pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete')resolve();}));}
async function offer(){init();attach(pc.createDataChannel('objects'));await pc.setLocalDescription(await pc.createOffer());await gathered();return JSON.stringify(pc.localDescription);}
async function answer(s){init();await pc.setRemoteDescription(JSON.parse(s));await pc.setLocalDescription(await pc.createAnswer());await gathered();return JSON.stringify(pc.localDescription);}
async function finish(s){await pc.setRemoteDescription(JSON.parse(s));}
async function stats(){return [...(await pc.getStats()).values()].filter(x=>['candidate-pair','local-candidate','remote-candidate','data-channel'].includes(x.type));}
$('offer').onclick=async()=>{$('signal').value=await offer();}; $('answer').onclick=async()=>{$('signal').value=await answer($('signal').value);};$('finish').onclick=()=>finish($('signal').value);$('send').onclick=()=>send(channel,chunks(fixture));
$('export').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([bundle(fixture)],{type:'application/octet-stream'}));a.download='opaque.bundle';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
$('file').onchange=async e=>{try{const obj=unbundle(new Uint8Array(await e.target.files[0].arrayBuffer()));log({imported:obj.id,bytes:[...obj.bytes]});}catch(error){log({error:String(error)});}};
window.proof={offer,answer,finish,stats,sendFixture:()=>send(channel,chunks(fixture)),get state(){return {connection:pc?.connectionState,channel:channel?.readyState,log:$('log').textContent}},receiver};
