import {registerRootComponent} from 'expo';
import React, {useRef, useState} from 'react';
import {Button, ScrollView, Text, TextInput, View} from 'react-native';
import {RTCPeerConnection, RTCSessionDescription} from 'react-native-webrtc';

function App() {
  const [signal,setSignal]=useState(''), [events,setEvents]=useState('');
  const peer=useRef(null), channel=useRef(null);
  const log = message => setEvents(previous => previous + message + '\n');
  const attach = c => {channel.current=c;c.onopen=()=>log('channel open');c.onclose=()=>log('channel closed');c.onmessage=e=>{log('received '+String(e.data));if(e.data==='opaque:000102ff') c.send('received-in-memory:fixture-object');};};
  const init = () => {peer.current?.close();const p=new RTCPeerConnection({iceServers:[]});peer.current=p;p.ondatachannel=e=>attach(e.channel);p.onconnectionstatechange=()=>log('connection '+p.connectionState);return p;};
  const gather = p => new Promise((resolve,reject)=>{if(p.iceGatheringState==='complete')return resolve();const timer=setTimeout(()=>reject(Error('ICE gathering timeout')),30000);p.onicegatheringstatechange=()=>{if(p.iceGatheringState==='complete'){clearTimeout(timer);resolve();}};});
  const run = async fn => {try{await fn();}catch(e){log('error '+String(e));}};
  const offer = () => run(async()=>{const p=init();attach(p.createDataChannel('objects'));await p.setLocalDescription(await p.createOffer());await gather(p);setSignal(JSON.stringify(p.localDescription));});
  const answer = () => run(async()=>{const p=init();await p.setRemoteDescription(new RTCSessionDescription(JSON.parse(signal)));await p.setLocalDescription(await p.createAnswer());await gather(p);setSignal(JSON.stringify(p.localDescription));});
  const finish = () => run(()=>peer.current.setRemoteDescription(new RTCSessionDescription(JSON.parse(signal))));
  return <ScrollView contentContainerStyle={{padding:24,gap:8}}><Text>Manual direct transport probe. Fixture is not encrypted. Paste signaling out of band.</Text><Button title="Create offer" onPress={offer}/><Button title="Accept offer / create answer" onPress={answer}/><Button title="Accept answer" onPress={finish}/><Button title="Send fixture" onPress={()=>run(async()=>channel.current.send('opaque:000102ff'))}/><Button title="Disconnect" onPress={()=>{channel.current?.close();peer.current?.close();}}/><TextInput accessibilityLabel="Signaling" multiline value={signal} onChangeText={setSignal} style={{minHeight:160,borderWidth:1}}/><Text selectable>{events}</Text></ScrollView>;
}
registerRootComponent(App);
