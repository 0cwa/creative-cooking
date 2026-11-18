import {useContext,useState} from 'react';
import {Platform,Pressable,Text,TextInput,View} from 'react-native';
import {useAppState} from '@/state/AppState';
import {LoroWorkspaceValue} from './WorkspaceStatus';
import {PersonalRecoveryPanel} from './PersonalRecoveryPanel';
import {MAX_PERSONAL_TRANSFER,parsePersonalTransfer,personalRecipientTransfer} from './personal-rotation.mjs';
import {chooseExchangeFile,saveExchangeFile} from './exchange-file';

type Review = {
 operationId:string; parent:string; pin:string; devices:string[]; deviceId:string;
 source:{documentId:string;revision:number|null;hash:string|null};
};
type Transfer = {packages:Record<string,string>};

export function PersonalAuthority(){
 const workspace=useContext(LoroWorkspaceValue),app=useAppState();
 const service=workspace.personalRotation;
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
 const [review,setReview]=useState<Review|null>(null),[retired,setRetired]=useState<string[]>([]);
 const [request,setRequest]=useState(''),[generated,setGenerated]=useState(''),[fingerprint,setFingerprint]=useState('');
 const [requests,setRequests]=useState<any[]>([]);
 const [transfer,setTransfer]=useState<Transfer|null>(null),[incoming,setIncoming]=useState('');
 const [confirmedPin,setConfirmedPin]=useState(''),[confirmedParent,setConfirmedParent]=useState('');
 const [reopen,setReopen]=useState<{scopeId:string;head:string;kind:'personal'}|null>(null);
 if(!service)return null;

 const run=(action:()=>Promise<void>)=>{
  setBusy(true);setStatus('');
  void action().catch(e=>{
   const code=e instanceof Error?e.message:'';
   setStatus(code==='CONFLICT'?'Personal authority or saved data changed. Reopen and review the current copy before retrying.':
    code==='VERIFY_PERSONAL_PARENT'?'Confirm the personal root and previous authority with the surviving device.':
    code==='UNAUTHORIZED_DEVICE'?'This device has no authorization in that personal transfer.':
    code==='MISSING_RECOVERY'?'Restore a personal archive in this workspace first.':
    code==='TOO_LARGE'?'The personal copy or transfer exceeds the size limit.':
    code==='INVALID_RECIPIENTS'?'Retire each affected device and confirm a request from every other device you want to keep.':
    'The personal authority action could not be completed. Check the transfer or request before trying again.');
  }).finally(()=>setBusy(false));
 };
 const saved=async(action:()=>Promise<void>)=>{
  const release=app.beginWorkspaceTransition();
  try{await app.flushCurrentWorkspace();await action()}finally{release()}
 };
 const button=(label:string,action:()=>Promise<void>,disabled=false)=>
  <Pressable accessibilityRole="button" disabled={busy||disabled} onPress={()=>run(action)}><Text>{label}</Text></Pressable>;
 const makeRequest=async(target:'current'|'archive')=>{
  const item=await service.request(target);
  setGenerated(JSON.stringify(item));setStatus('Personal request fingerprint '+await service.fingerprint(item));
 };
 const fileTransfer=async(deviceId:string)=>{
  const value=personalRecipientTransfer(transfer,deviceId),text=JSON.stringify(value);
  const bytes=new TextEncoder().encode(text);
  if(bytes.length>MAX_PERSONAL_TRANSFER)throw Error('TOO_LARGE');
  await saveExchangeFile('creative-cooking-personal-successor.json','application/json',bytes);
 };
 return <View style={{gap:8}}>
  <Text accessibilityRole="header">Personal authority</Text>
  <Text accessibilityLabel="Personal document generation">Personal generation {workspace.personal.scope.documentGeneration}</Text>
  <Pressable accessibilityRole="button" onPress={()=>setOpen(!open)}><Text>{open?'Close personal authority':'Manage personal authority after compromise'}</Text></Pressable>
  {open?<View style={{gap:10}}>
   <Text>Use a trusted surviving personal device. Review the exact saved copy, retire affected devices, and authorize each device that will receive the new private key. Older copies and recovery packages can still be read by their holders.</Text>
   <Text>Household continuity can be registered separately in Household recovery. Rotate personal recovery codes and guardian shares from the reopened personal workspace.</Text>
   {button('Review personal key rotation',()=>saved(async()=>{setReview(await service.review());setRetired([]);setRequests([]);setTransfer(null)}),!!reopen)}
   {review&&!reopen?<View style={{gap:8}}>
    <Text selectable>Personal root pin {review.pin}</Text>
    <Text selectable>Previous personal authority {review.parent}</Text>
    <Text>Saved copy {review.source.revision===null?'has no edits':`revision ${review.source.revision}`}. This device remains authorized.</Text>
    {review.devices.filter(d=>d!==review.deviceId).map(device=><Pressable key={device} accessibilityRole="checkbox"
     accessibilityState={{checked:retired.includes(device),disabled:busy}} disabled={busy}
     accessibilityLabel={`Retire personal device ${device}`}
     onPress={()=>setRetired(old=>old.includes(device)?old.filter(d=>d!==device):[...old,device])}>
     <Text>{retired.includes(device)?'Retire':'Keep if verified'} {device}</Text>
    </Pressable>)}
    <Text>Compare each request fingerprint with the intended device through a separate channel before accepting its request.</Text>
    <TextInput accessibilityLabel="Personal successor request" value={request} onChangeText={setRequest} multiline maxLength={8192} />
    <TextInput accessibilityLabel="Confirmed personal request fingerprint" value={fingerprint} onChangeText={setFingerprint} autoCapitalize="none" autoCorrect={false} />
    {button('Include verified personal device',async()=>{
     const item=parsePersonalTransfer(request,8192);
     if(await service.fingerprint(item)!==fingerprint.trim())throw Error('INVALID_REQUEST');
     if(item.request.pin!==review.pin||item.request.scopeId!==service.current.scopeId||
       requests.some(x=>x.request.deviceId===item.request.deviceId))throw Error('INVALID_REQUEST');
     setRequests(old=>[...old,item]);setRequest('');setFingerprint('');
    },!request||!fingerprint)}
    {requests.map(item=><View key={item.request.deviceId}><Text>Verified recipient {item.request.deviceId}</Text>
     {button(`Remove recipient ${item.request.deviceId}`,async()=>setRequests(old=>old.filter(row=>row!==item)))}</View>)}
    {button('Authorize successor and rotate personal key',()=>saved(async()=>{
     const result=await service.publish(review,retired,requests);
     setTransfer(result.transfer);setReopen({scopeId:result.scopeId,head:result.head,kind:'personal'});setStatus('Personal successor saved. Reopen the workspace to edit its current private copy.');
    }))}
   </View>:null}
   {button('Load latest personal successor files',async()=>{
    const result=await service.retainedTransfer();
    setTransfer(result);setStatus(result?'Personal successor files are ready.':'There are no personal successor files for other devices.');
   },!!reopen)}
   {transfer?Object.keys(transfer.packages).map(device=><View key={device}>
    {button(`Save successor for ${device}`,()=>fileTransfer(device))}
   </View>):null}
   {reopen?button('Reopen personal workspace',async()=>workspace.reopen(reopen)):<>
    <Text accessibilityRole="header">Use a personal successor on this device</Text>
    <Text>A recovery archive opens privately for reading. A surviving personal device can separately approve this device and send an encrypted successor file. Installing selects the recovered owner’s current copy. This workspace keeps its earlier private copy in local storage. Compare the root pin and previous personal authority with that device before installing.</Text>
    {workspace.recoveryImport?<PersonalRecoveryPanel read={workspace.recoveryImport.read} restore={workspace.recoveryImport.restore}/>:null}
    {workspace.recoveryImport?button('Request personal authority for restored archive',()=>makeRequest('archive')):null}
    {button('Request my next personal key',()=>makeRequest('current'))}
    {generated?<TextInput accessibilityLabel="My personal successor request" value={generated} multiline editable={false}/>:null}
    {Platform.OS==='web'?<input aria-label="Choose personal successor file" type="file" accept=".json,application/json"
     disabled={busy} onChange={event=>{const file=event.currentTarget.files?.[0];if(file)run(async()=>{
      if(file.size>MAX_PERSONAL_TRANSFER)throw Error('TOO_LARGE');setIncoming(await file.text());
     })}}/>:button('Choose personal successor file',async()=>{
     const bytes=await chooseExchangeFile({accept:['application/json'],minBytes:1,maxBytes:MAX_PERSONAL_TRANSFER});
     if(bytes)setIncoming(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    })}
    {incoming?<Text>Personal successor file selected.</Text>:null}
    <TextInput accessibilityLabel="Confirmed personal root pin" value={confirmedPin} onChangeText={setConfirmedPin} autoCapitalize="none" autoCorrect={false} />
    <TextInput accessibilityLabel="Confirmed previous personal authority" value={confirmedParent} onChangeText={setConfirmedParent} autoCapitalize="none" autoCorrect={false} />
    {button('Install verified personal successor',()=>saved(async()=>{
     const result=await service.install(parsePersonalTransfer(incoming),confirmedPin.trim(),confirmedParent.trim());
     setReopen({scopeId:result.scopeId,head:result.head,kind:'personal'});setStatus('Personal successor saved. Reopen the workspace to edit its current private copy.');
    }),!incoming||!confirmedPin||!confirmedParent)}
   </>}
   {status?<Text accessibilityRole="alert">{status}</Text>:null}
  </View>:null}
 </View>;
}
