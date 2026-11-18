import {useContext,useRef,useState,useSyncExternalStore} from 'react';
import {Platform,Pressable,Text,TextInput,View} from 'react-native';
import {useAppState} from '@/state/AppState';
import {LoroWorkspaceValue} from './WorkspaceStatus';
import {copyText} from './clipboard';
import {chooseExchangeFile,saveExchangeFile} from './exchange-file';
import {MAX_PERSONAL_PAIRING_FILE,MAX_PERSONAL_PAIRING_MESSAGE} from '../pairing/personal-copy.mjs';

type Role='initiator'|'responder';
type Proposal={text:string;code:string;rootPin:string;ownerId:string;peerDevice:string};
type Progress={text:string;stage:string;complete:boolean};
type History={rootDevice:string;ownerId:string;devices:{deviceId:string;active:boolean;local:boolean}[];
 events:{deviceId:string;sponsor:string;action:string}[]};
type Reopen={scopeId:string;head:string;authorizationSnapshot:string};
type PendingExport={file:Uint8Array;code:string;peerDevice:string};
type WorkspacePairing={selected?:Reopen;published?:Reopen;pendingExport?:PendingExport};
// Settings can unmount while the workspace and its pairing work stay open.
const workspacePairing=new WeakMap<object,WorkspacePairing>();
const pairingListeners=new Set<()=>void>();
const subscribePairing=(listener:()=>void)=>{
 pairingListeners.add(listener);
 return ()=>{pairingListeners.delete(listener)};
};
const noPairingState=()=>null;
function updateWorkspacePairing(workspace:object,change:WorkspacePairing){
 workspacePairing.set(workspace,{...workspacePairing.get(workspace),...change});
 for(const listener of pairingListeners)listener();
}

export function PersonalDevicePairing(){
 const workspace=useContext(LoroWorkspaceValue),app=useAppState(),service=workspace?.personalPairing;
 const [role,setRole]=useState<Role|null>(null),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
 const working=useRef(false);
 const [history,setHistory]=useState<History|null>(null);
 const [request,setRequest]=useState(''),[incoming,setIncoming]=useState(''),[proposal,setProposal]=useState<Proposal|null>(null);
 const [peerPin,setPeerPin]=useState(''),[root,setRoot]=useState(''),[code,setCode]=useState('');
 const [progress,setProgress]=useState<Progress|null>(null),[peerProof,setPeerProof]=useState('');
 const [file,setFile]=useState<Uint8Array|null>(null);
 const pairing=useSyncExternalStore(subscribePairing,()=>workspace?workspacePairing.get(workspace)??null:null,noPairingState);
 const reopen=pairing?.selected??pairing?.published;
 const pendingExport=pairing?.pendingExport;
 if(!service)return null;
 const run=(action:()=>Promise<void>)=>{
  if(working.current)return;
  working.current=true;setBusy(true);setStatus('');
  void action().catch(error=>{
   const message=error instanceof Error?error.message:'';
   setStatus(message==='OOB_REQUIRED'?'The independently confirmed fingerprint, root pin or transcript code does not match.':
    message==='CONFLICT'||message==='INCOMPLETE'?'The saved pairing state changed or the device checks are incomplete. Review both devices before continuing.':
    message==='ORIGINAL_REQUIRED'?'Open this device’s original personal workspace before receiving another private copy.':
    message==='TOO_LARGE'||message==='INVALID_FILE_SIZE'?'The pairing message or file exceeds the supported size.':
    'Pairing could not continue. Check that the message or encrypted file came from the verified device and matches this session.');
  }).finally(()=>{working.current=false;setBusy(false)});
 };
 const button=(label:string,action:()=>Promise<void>,disabled=false)=>
  <Pressable accessibilityRole="button" disabled={busy||disabled} onPress={()=>run(action)}><Text>{label}</Text></Pressable>;
 const field=(label:string,value:string,change:(value:string)=>void,multiline=false)=>
  <TextInput accessibilityLabel={label} value={value} onChangeText={change} editable={!busy} multiline={multiline}
   maxLength={multiline?MAX_PERSONAL_PAIRING_MESSAGE:64} autoCapitalize="none" autoCorrect={false}/>;
 const output=(label:string,value:string)=><View style={{gap:4}}>
  <TextInput accessibilityLabel={label} value={value} multiline editable={false}/>
  {button(label.replace(/^My /,'Copy '),async()=>{
   setStatus(await copyText(value)?'Pairing message copied.':'Could not copy the pairing message.');
  })}
 </View>;
 const reset=(next:Role)=>{
  setRole(next);setRequest('');setIncoming('');setPeerPin('');setRoot('');setCode('');
  setProposal(null);setProgress(null);setPeerProof('');setFile(null);
 };
 const open=async(next:Role)=>{
  reset(next);
  if(next==='responder')setRequest(await service.request());
  const saved=await service.resume(next);
  if(saved){setProposal(saved);setPeerPin(saved.peerFingerprint);setProgress(saved.progress)}
 };
 const reopenPersonal=(target:Reopen)=>workspace.reopen({...target,kind:'personal'});
 const selectPersonal=async<T extends Reopen,>(select:()=>Promise<T>)=>{
  const finish=app.beginWorkspaceTransition();
  let saved=false;
  try{
   await app.flushCurrentWorkspace();
   const result=await select();
   saved=true;
   updateWorkspacePairing(workspace,{selected:result});
   return result;
  }finally{if(!saved)finish()}
 };
 const finishReopen=async(target:Reopen)=>{
  if(workspacePairing.get(workspace)?.selected){reopenPersonal(target);return;}
  const finish=app.beginWorkspaceTransition();
  try{await app.flushCurrentWorkspace();reopenPersonal(target)}
  catch(error){finish();throw error;}
 };
 const exportCommitted=async(committed:PendingExport,replayed:boolean)=>{
  try{
   await saveExchangeFile('creative-cooking-personal-pairing.ccpair','application/octet-stream',committed.file);
   if(workspacePairing.get(workspace)?.pendingExport===committed)updateWorkspacePairing(workspace,{pendingExport:undefined});
   setStatus(replayed?'The same encrypted pairing file is ready.':'Device authorization saved. Send the encrypted file to the verified device to finish on that screen.');
  }catch{
   setStatus('Device authorization saved. The file could not be exported. Use Save encrypted personal pairing file to retry.');
  }
 };
 const save=async()=>{
  const confirmed=proposal;
  if(!confirmed)throw Error('OOB_REQUIRED');
  const finish=app.beginWorkspaceTransition();
  let committed:PendingExport,replayed:boolean;
  try{
   await app.flushCurrentWorkspace();
   if(workspacePairing.get(workspace)?.pendingExport)throw Error('CONFLICT');
   const result=await service.publish(confirmed.code);
   const {file,scopeId,head,authorizationSnapshot}=result;
   replayed=result.replayed;
   committed={code:confirmed.code,peerDevice:confirmed.peerDevice,file};
   updateWorkspacePairing(workspace,{published:{scopeId,head,authorizationSnapshot},pendingExport:committed});
  }finally{finish()}
  await exportCommitted(committed,replayed);
 };
 return <View style={{gap:8}}>
  <Text accessibilityRole="header">Personal devices</Text>
  <Text>Pair your own devices to share the saved private copy, including Chef conversations, proposals and personal preferences. Provider API keys stay on the device where you configured them. Household access and voting stay separate.</Text>
  <Text selectable accessibilityLabel="This personal device">{service.deviceId}</Text>
  <Text selectable accessibilityLabel="This personal device fingerprint">{service.fingerprint}</Text>
  <Text selectable accessibilityLabel="This workspace personal root pin">{service.rootPin}</Text>
  {button('Show verified personal device history',async()=>setHistory(await service.history()))}
  {history?<View accessibilityLabel="Verified personal device history" style={{gap:4}}>
   <Text selectable>Personal owner {history.ownerId}</Text>
   <Text selectable>Original device {history.rootDevice}</Text>
   {history.devices.map(device=><Text key={device.deviceId} selectable>{device.deviceId} · {device.active?'Authorized':'Retired'}{device.local?' · This device':''}</Text>)}
   {history.events.map((event,index)=><Text key={index} selectable>{event.action} {event.deviceId} by {event.sponsor}</Text>)}
  </View>:null}
  {button('Pair from this device',()=>open('initiator'),!!reopen)}
  {button('Receive my private copy',()=>open('responder'),!!reopen)}
  {!service.usingOriginal?button('Return to original personal workspace',async()=>reopenPersonal(await selectPersonal(()=>service.returnToOriginal())),!!reopen):null}
  {role==='initiator'&&proposal&&!reopen?button('Prepare another device',async()=>reset('initiator')):null}
  {role==='responder'&&service.usingOriginal&&!reopen?button('Create a new personal pairing request',async()=>{
   const renewed=await service.request(true);reset('responder');setRequest(renewed);
  }):null}
  {role&&!progress?<View style={{gap:8}}>
   {role==='responder'&&request?output('My personal pairing request',request):null}
   {!proposal?<Text>Send the pairing message through your chosen channel. Read or compare the device fingerprints directly on the two devices or through a separate trusted channel.</Text>:null}
   {role==='initiator'&&!proposal?<>
    {field('Incoming personal pairing request',incoming,setIncoming,true)}
    {field('Confirmed peer device fingerprint',peerPin,setPeerPin)}
    {button('Prepare personal pairing proposal',async()=>setProposal(await service.propose(incoming,peerPin.trim())),!incoming||!peerPin)}
   </>:null}
   {role==='responder'&&!proposal?<>
    {field('Incoming personal pairing proposal',incoming,setIncoming,true)}
    {button('Review personal pairing proposal',async()=>setProposal(await service.inspect(incoming)),!incoming)}
   </>:null}
   {proposal?<>
    {role==='initiator'?output('My personal pairing proposal',proposal.text):null}
    <Text selectable>Pair with device {proposal.peerDevice} for personal owner {proposal.ownerId}.</Text>
    <Text selectable accessibilityLabel="Pairing transcript code">{proposal.code}</Text>
    <Text>Compare the transcript codes on both screens. Confirm the root pin shown by the existing device and the fingerprint shown by the other device through your separate trusted channel. Enter those values here on each device.</Text>
    {field('Confirmed peer device fingerprint',peerPin,setPeerPin)}
    {field('Confirmed pairing root pin',root,setRoot)}
    {field('Confirmed pairing transcript code',code,setCode)}
    {button('Confirm personal pairing on this device',async()=>setProgress(await service.confirm(role,proposal.text,peerPin.trim(),root.trim(),code.trim())),
      !peerPin||!root||!code)}
   </>:null}
  </View>:null}
  {role&&progress?<View style={{gap:8}}>
   <Text>{progress.complete?'Both devices proved possession of their pairing keys.':`${progress.stage} ready. Exchange the latest proof from each device until both show verification complete.`}</Text>
   {output('My personal pairing proof',progress.text)}
   {field('Incoming personal pairing proof',peerProof,setPeerProof,true)}
   {button('Accept personal pairing proof',async()=>{setProgress(await service.accept(role,peerProof));setPeerProof('')},!peerProof)}
   {progress.complete&&role==='initiator'&&!pendingExport?button('Save encrypted personal pairing file',save):null}
   {progress.complete&&role==='responder'?<>
    {button('Choose encrypted personal pairing file',async()=>{
     const chosen=await chooseExchangeFile({accept:Platform.OS==='web'?['application/octet-stream','.ccpair']:['*/*'],minBytes:113,maxBytes:MAX_PERSONAL_PAIRING_FILE});
     setFile(chosen);if(chosen)setStatus('Encrypted pairing file selected. Review and select the verified copy to open it.');
    })}
    {button('Install and select verified personal copy',async()=>{
     const result=await selectPersonal<Reopen & {replayed:boolean}>(()=>service.install(file));
     setStatus(result.replayed?'The same verified personal copy is selected.':'Verified private copy saved and selected. Reopen to use it.');
    },!file||!!reopen)}
   </>:null}
  </View>:null}
  {pendingExport?<View style={{gap:4}}>
   <Text selectable>Saved pairing file for device {pendingExport.peerDevice}.</Text>
   <Text selectable accessibilityLabel="Saved pairing transcript code">{pendingExport.code}</Text>
   {button('Save encrypted personal pairing file',async()=>{
    if(workspacePairing.get(workspace)?.pendingExport!==pendingExport)throw Error('CONFLICT');
    await exportCommitted(pendingExport,true);
   })}
  </View>:null}
  {reopen?button('Reopen paired personal workspace',()=>finishReopen(reopen)):null}
  {status?<Text accessibilityRole="alert">{status}</Text>:null}
 </View>;
}
