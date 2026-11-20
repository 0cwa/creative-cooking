import {useContext,useRef,useState} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import {useAppState} from '@/state/AppState';
import {LoroWorkspaceValue} from './WorkspaceStatus';
import {PublicMessageFile} from './PublicMessageFile';
import {chooseExchangeFile} from './exchange-file';
import {copyText} from './clipboard';
import {MAX_HOUSEHOLD_OWN_DEVICE_MESSAGE as limit} from './household-own-device.mjs';
import {MAX_PERSONAL_PAIRING_FILE} from '../pairing/personal-copy.mjs';

const encode=(value:any)=>JSON.stringify(value,(_key,v)=>v instanceof Uint8Array?{__bytes:Array.from(v)}:v);
const decode=(text:string)=>JSON.parse(text,(_key,v)=>{
 if(v&&typeof v==='object'&&Object.keys(v).length===1&&Array.isArray(v.__bytes)){
  if(v.__bytes.length>limit||!v.__bytes.every((x:any)=>Number.isInteger(x)&&x>=0&&x<=255))throw Error('Invalid message bytes.');
  return Uint8Array.from(v.__bytes);
 }
 return v;
});

export function HouseholdOwnDeviceEstablished({onLocked}:{onLocked:(value:boolean)=>void}){
 const workspace=useContext(LoroWorkspaceValue),app=useAppState(),pairing=workspace?.householdPairing;
 const [open,setOpen]=useState(false),[offer,setOffer]=useState(''),[code,setCode]=useState(''),[peer,setPeer]=useState(''),[out,setOut]=useState(''),[phase,setPhase]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[target,setTarget]=useState<any>(null);
 const session=useRef<any>(null),verified=useRef<any>(null),paused=useRef<null|(()=>void)>(null),working=useRef(false);
 if(!pairing?.ownDevice)return null;
 const clear=()=>{session.current=null;verified.current=null;setOut('');setPhase('');setPeer('')};
 const run=(fn:()=>Promise<void>)=>{if(working.current)return;working.current=true;setBusy(true);setNotice('');void fn().catch((e:Error)=>{setNotice(e.message==='SOURCE_CHANGED'||e.message==='CONFLICT'||e.message==='LOCAL_EDITS_CONFLICT'?'Household changes were made after the copy was prepared. Keep those edits and ask the sponsor to prepare a fresh copy.':e.message||'Could not verify this device.');}).finally(()=>{working.current=false;setBusy(false)})};
 const button=(label:string,fn:()=>Promise<void>,disabled=false)=><Pressable accessibilityRole="button" disabled={busy||disabled} onPress={()=>run(fn)}><Text>{label}</Text></Pressable>;
 const input=(label:string,value:string,change:(v:string)=>void,multiline=false)=><TextInput accessibilityLabel={label} value={value} onChangeText={change} multiline={multiline} maxLength={multiline?limit:128} editable={!busy} autoCapitalize="none" autoCorrect={false}/>;
 const output=(label:string,value:string)=><><TextInput accessibilityLabel={label} value={value} multiline editable={false}/><PublicMessageFile label={label.toLowerCase()} outgoing={value} limit={limit} run={run} disabled={busy}/>{button('Copy '+label.toLowerCase(),async()=>{if(!await copyText(value))throw Error('Could not copy the message.')})}</>;
 const show=(value:any)=>{setOut(encode(value.ack??value.response??value.offer));setPhase(value.complete?'complete':value.ack?'ack':value.response?'response':'offer')};
 const begin=async()=>{clear();const v=await pairing.ownDevice.verifyEstablishedOffer(offer,code.trim());const s=pairing.session({...v,role:'responder',confirmedHash:code.trim()});await s.initialize();const result=await s.outgoing();verified.current=v;session.current=s;show(result)};
 const advance=async()=>{const s=session.current;if(!s)throw Error('Start verification first.');const current=await s.outgoing(),message=decode(peer);if(current.revision===0)await s.respond(message,0);else if(current.revision===1)await s.acknowledge(message,1);else if(current.revision===2)await s.finish(message,2);else throw Error('Verification is already complete.');setPeer('');show(await s.outgoing())};
 const install=async()=>{
  onLocked(true);
  let release:(()=>void)|undefined,advanced=false;
  try{
   if(!session.current||!verified.current||!(await session.current.outgoing()).complete)throw Error('Complete device verification first.');
   const bytes=await chooseExchangeFile({accept:['application/octet-stream','.cchouse'],minBytes:48,maxBytes:MAX_PERSONAL_PAIRING_FILE});
   if(!bytes)return;
   release=app.beginWorkspaceTransition();
   await app.flushCurrentWorkspace();
   const checked=await pairing.ownDevice.verifyEstablishedOffer(offer,code.trim());
   if(encode(checked)!==encode(verified.current))throw Error('The verified offer changed. Start verification again.');
   const evidence={...checked,messages:(await session.current.evidence()).messages};
   const result=await pairing.ownDevice.installEstablished(bytes,evidence);
   advanced=true;paused.current=release;setTarget(result);setNotice('Household installed. Editing is paused until you reopen the verified household.');
  }finally{
   if(!advanced){release?.();onLocked(false)}
  }
 };
 return <View style={{gap:8}}>{button(open?'Close paired-household update':'Receive paired-household update',async()=>setOpen(!open),!!target)}{open?<>
  <Text>Send your public identity to the sponsor. Compare the offer code separately, exchange verification messages, then import the encrypted file labeled for this device.</Text>
  {output('Existing household device public identity',encode(pairing.identity))}
  {input('Incoming paired-household offer',offer,v=>{clear();setOffer(v)},true)}
  <PublicMessageFile label="paired-household offer" limit={limit} onRead={v=>{clear();setOffer(v)}} run={run} disabled={busy}/>
  {input('Confirmed paired-household offer code',code,v=>{clear();setCode(v)})}
  {button('Confirm paired-household offer',begin,!offer||!code||!!target)}
  {phase?<><Text>{phase==='complete'?'Verification complete.':`Exchange the ${phase} message with the sponsor.`}</Text>{output('Paired-household verification message',out)}
   {phase!=='complete'?<>{input('Incoming paired-household verification message',peer,setPeer,true)}<PublicMessageFile label="paired-household verification message" limit={limit} onRead={setPeer} run={run} disabled={busy}/>{button('Accept paired-household verification message',advance,!peer)}</>:button('Import encrypted paired-household update',install,!!target)}</>:null}
  {target?button('Reopen verified paired household',async()=>{workspace.reopen({scopeId:target.scope.id,head:target.head})}):null}
  {notice?<Text accessibilityRole="alert">{notice}</Text>:null}
 </>:null}</View>;
}
