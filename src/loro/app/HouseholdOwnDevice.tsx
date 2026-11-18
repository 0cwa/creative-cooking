import {useContext,useRef,useState} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import {useAppState} from '@/state/AppState';
import {chooseExchangeFile,saveExchangeFile} from './exchange-file';
import {copyText} from './clipboard';
import {PublicMessageFile} from './PublicMessageFile';
import {LoroWorkspaceValue} from './WorkspaceStatus';
import {MAX_HOUSEHOLD_OWN_DEVICE_MESSAGE} from './household-own-device.mjs';
import {MAX_PERSONAL_PAIRING_FILE} from '../pairing/personal-copy.mjs';

type Role='initiator'|'responder';
type Proposal={text:string;code:string;rootPin:string;head:string;adultId:string;peerDevice:string};
type Progress={text:string;stage:string;complete:boolean};
type Target={scope:{kind:'household';id:string};head:string};
type History={head:string;roster:string[];threshold:number;policy:{kind:string};
 devices:{deviceId:string;adultId:string;active:boolean}[];
 events:{action:string;deviceId:string;sponsor:string;adultId:string}[]};

export function HouseholdOwnDevice(){
 const workspace=useContext(LoroWorkspaceValue),app=useAppState(),pairing=workspace?.householdPairing,service=pairing?.ownDevice;
 const [open,setOpen]=useState(false),[role,setRole]=useState<Role|null>(null);
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),working=useRef(false);
 const [history,setHistory]=useState<History|null>(null),[request,setRequest]=useState(''),[input,setInput]=useState('');
 const [proposal,setProposal]=useState<Proposal|null>(null),[progress,setProgress]=useState<Progress|null>(null);
 const [peer,setPeer]=useState(''),[root,setRoot]=useState(''),[head,setHead]=useState(''),[code,setCode]=useState('');
 const [proof,setProof]=useState(''),[file,setFile]=useState<Uint8Array|null>(null);
 const [update,setUpdate]=useState(''),[incomingUpdate,setIncomingUpdate]=useState('');
 const [installed,setInstalled]=useState<Target|null>(null),[published,setPublished]=useState<string|null>(null);
 if(!service)return null;
 const run=(fn:()=>Promise<void>)=>{
  if(working.current)return;
  working.current=true;setBusy(true);setNotice('');
  void fn().catch((error:Error)=>setNotice(error.message==='OOB_REQUIRED'?
   'The confirmed household root, head, device fingerprint or transcript did not match.':
   error.message==='STALE_AUTHORITY'||error.message==='CONFLICT'?
    'The household or saved pairing session changed. Review the household and prepare a fresh request.':
    'Household pairing could not continue. Check the verified message or file and try again.'))
   .finally(()=>{working.current=false;setBusy(false)});
 };
 const button=(name:string,fn:()=>Promise<void>,disabled=false)=>
  <Pressable accessibilityRole="button" disabled={busy||disabled} onPress={()=>run(fn)}><Text>{name}</Text></Pressable>;
 const field=(name:string,value:string,onChangeText:(value:string)=>void,multiline=false)=>
  <TextInput accessibilityLabel={name} value={value} onChangeText={onChangeText} autoCapitalize="none" autoCorrect={false}
   maxLength={multiline?MAX_HOUSEHOLD_OWN_DEVICE_MESSAGE:64} multiline={multiline} editable={!busy}/>;
 const output=(name:string,value:string)=><>
  <TextInput accessibilityLabel={name} value={value} multiline editable={false}/>
  <PublicMessageFile label={name.toLowerCase()} outgoing={value} limit={MAX_HOUSEHOLD_OWN_DEVICE_MESSAGE} run={run} disabled={busy}/>
  {button('Copy '+name.toLowerCase(),async()=>setNotice(await copyText(value)?'Message copied.':'Could not copy the message.'))}
 </>;
 const start=async(next:Role,renew=false)=>{
  setRole(next);setProposal(null);setProgress(null);setInput('');setPeer('');setRoot('');setHead('');setCode('');setProof('');setFile(null);
  if(next==='responder'){
   setRequest(await service.request(renew));
   if(renew)setInstalled(null);
  }
  const saved=await service.resume(next);
  if(saved){setProposal(saved);setProgress(saved.progress);if(saved.installed)setInstalled(saved.installed);}
 };
 const save=async()=>{
  const finish=app.beginWorkspaceTransition();
  try {
   await app.flushCurrentWorkspace();
   if(!proposal)throw Error('OOB_REQUIRED');
   const result=await service.publish(proposal.code);
   setPublished(result.head);setUpdate(result.update);
   await saveExchangeFile('creative-cooking-household-device.cchouse','application/octet-stream',result.file);
   setNotice(result.replayed?'The retained encrypted household pairing file is ready.':'Household device authorized. Send the encrypted file to the verified device.');
  } finally {finish()}
 };
 const reopen=async(target:Target,select:boolean)=>{
  const finish=app.beginWorkspaceTransition();
  try {
   await app.flushCurrentWorkspace();
   if(select)await pairing.selection.select(target.scope,target.head);
   workspace.reopen({scopeId:target.scope.id,head:target.head});
  }catch(error){finish();throw error}
 };
 return <View style={{gap:8}}>
  {button(open?'Close household device pairing':'Pair my household devices',async()=>setOpen(!open))}
  {open?<View style={{gap:8}}>
   <Text accessibilityRole="header">Your household devices</Text>
   <Text>Use a device with household access to authorize another device for the same adult. The new device gets the selected cooking document and its current data key. Every adult keeps one vote.</Text>
   <Text selectable accessibilityLabel="This household pairing device fingerprint">{service.fingerprint}</Text>
   <Text selectable accessibilityLabel="Household pairing root to compare">{service.rootPin}</Text>
   <Text selectable accessibilityLabel="Household pairing head to compare">{history?.head??workspace.household.scope.branchHead}</Text>
   {button('Show verified household device history',async()=>setHistory(await service.history()))}
   {history?<View accessibilityLabel="Verified household device history">
    <Text selectable>Adults {history.roster.join(' · ')}</Text>
    <Text>Adult approval threshold {history.threshold} of {history.roster.length} · {history.policy.kind}</Text>
    {history.devices.map(device=><Text key={device.deviceId} selectable>{device.deviceId} · {device.adultId} · {device.active?'Authorized':'Retired'}</Text>)}
    {history.events.map(event=><Text key={event.action+event.deviceId} selectable>{event.action} {event.deviceId} by {event.sponsor} for {event.adultId}</Text>)}
   </View>:null}
   {button('Sponsor my other household device',()=>start('initiator'))}
   {button('Receive my household access',()=>start('responder'))}
   {role==='responder'?button('Create a fresh household pairing request',()=>start('responder',true)):null}
   {role==='initiator'&&proposal&&!published?button('Prepare another household pairing proposal',async()=>{
    setProposal(null);setProgress(null);setInput('');setProof('');
   }):null}
   {role&&!progress?<>
    {role==='responder'&&request?output('My household pairing request',request):null}
    {!proposal?<>
     {field(role==='initiator'?'Incoming household pairing request':'Incoming household pairing proposal',input,setInput,true)}
     <PublicMessageFile label={role==='initiator'?'household pairing request':'household pairing proposal'} onRead={setInput}
      limit={MAX_HOUSEHOLD_OWN_DEVICE_MESSAGE} run={run} disabled={busy}/>
     {role==='initiator'?field('Confirmed household peer fingerprint',peer,setPeer):null}
     {button(role==='initiator'?'Prepare household pairing proposal':'Review household pairing proposal',async()=>{
      setProposal(await (role==='initiator'?service.propose(input,peer.trim()):service.inspect(input)));
     },!input||role==='initiator'&&!peer)}
    </>:<>
     {role==='initiator'?output('My household pairing proposal',proposal.text):null}
     <Text selectable>Pair device {proposal.peerDevice} for household adult {proposal.adultId}.</Text>
     <Text selectable accessibilityLabel="Household pairing transcript to compare">{proposal.code}</Text>
     <Text>Compare the fingerprint on the other device and the transcript on both devices. Confirm the root and head displayed by the sponsoring device through your trusted channel.</Text>
     {field('Confirmed household peer fingerprint',peer,setPeer)}
     {field('Confirmed pairing household root',root,setRoot)}
     {field('Confirmed pairing household head',head,setHead)}
     {field('Confirmed household pairing transcript',code,setCode)}
     {button('Confirm household pairing on this device',async()=>setProgress(await service.confirm(role,proposal.text,peer.trim(),root.trim(),head.trim(),code.trim())),!peer||!root||!head||!code)}
    </>}
   </>:null}
   {role&&progress?<>
    <Text>{progress.complete?'Both devices proved possession of their household pairing keys.':`${progress.stage} ready. Exchange the latest proof from each device.`}</Text>
    {output('My household pairing proof',progress.text)}
    {field('Incoming household pairing proof',proof,setProof,true)}
    <PublicMessageFile label="household pairing proof" onRead={setProof} limit={16*1024} run={run} disabled={busy}/>
    {button('Accept household pairing proof',async()=>{setProgress(await service.accept(role,proof));setProof('')},!proof)}
    {progress.complete&&role==='initiator'?button('Save encrypted household pairing file',save):null}
    {progress.complete&&role==='responder'?<>
     {button('Choose encrypted household pairing file',async()=>{
      const bytes=await chooseExchangeFile({accept:['application/octet-stream','.cchouse'],minBytes:113,maxBytes:MAX_PERSONAL_PAIRING_FILE});
      setFile(bytes);if(bytes)setNotice('Encrypted household pairing file selected.');
     })}
     {button('Install verified household device',async()=>{
      const result=await service.install(file);
      setInstalled(result);setNotice(result.replayed?'The same household pairing is already installed.':'Household installed. Open it when you are ready to switch.');
     },!file)}
    </>:null}
   </>:null}
   {update?output('Signed household device update',update):null}
   {role===null?<>
    <Text>Already authorized on this household? Apply the signed device update after your cooking changes are up to date with the sponsor.</Text>
    {field('Incoming signed household device update',incomingUpdate,setIncomingUpdate,true)}
    <PublicMessageFile label="signed household device update" onRead={setIncomingUpdate} limit={MAX_HOUSEHOLD_OWN_DEVICE_MESSAGE}
     run={run} disabled={busy}/>
    {button('Apply signed household device update',async()=>{
     const finish=app.beginWorkspaceTransition();
     try{
      await app.flushCurrentWorkspace();
      const result=await service.acceptExisting(incomingUpdate,true);
      setPublished(result.head);setIncomingUpdate('');
      setNotice('Household device update saved. Reopen to continue cooking.');
     }finally{finish()}
    },!incomingUpdate)}
   </>:null}
   {installed?button('Open paired household',()=>reopen(installed,true)):null}
   {published&&published!==workspace.household.scope.branchHead?button('Reopen household after device pairing',()=>reopen({scope:{kind:'household',id:workspace.household.scope.scopeId},head:published},false)):null}
   {notice?<Text accessibilityRole="alert">{notice}</Text>:null}
  </View>:null}
 </View>;
}
