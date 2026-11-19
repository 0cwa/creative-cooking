import {useContext,useRef,useState,useSyncExternalStore} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import {useAppState} from '@/state/AppState';
import {LoroWorkspaceValue} from './WorkspaceStatus';
import {PublicMessageFile} from './PublicMessageFile';
import {copyText} from './clipboard';
import {chooseExchangeFile,saveExchangeFile} from './exchange-file';
import {decodeAdultRemovalRelease,encodeAdultRemovalRelease,MAX_ADULT_REMOVAL_FILE} from '../pairing/adult-removal-wire.mjs';

const messageLimit=16*1024*1024, bindingLimit=128*1024, bindingsLimit=512*1024;
type Target={scopeId:string;head:string};
const pendingTargets=new WeakMap<object,Target>();
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)};};
const empty=()=>null;
function pending(workspace:object,target:Target){pendingTargets.set(workspace,target);for(const listener of listeners)listener();}
function parseMessage(value:string){if(new TextEncoder().encode(value).length>messageLimit)throw Error('TOO_LARGE');return JSON.parse(value);}
function proposalMessage(proposal:any,publisherParent:any){
 const text=JSON.stringify(publisherParent?{version:1,proposal,publisherParent:{...publisherParent,authorityState:Array.from(publisherParent.authorityState)}}:proposal);
 if(new TextEncoder().encode(text).length>messageLimit)throw Error('TOO_LARGE');
 return text;
}
function readProposal(value:string){
 const parsed=parseMessage(value);
 if(parsed?.version!==1||!Object.hasOwn(parsed,'proposal'))return {proposal:parsed,publisherParent:undefined};
 const parent=parsed.publisherParent,bytes=parent?.authorityState;
 if(Object.keys(parsed).sort().join(',')!=='proposal,publisherParent,version'||!Array.isArray(bytes)||!bytes.length||bytes.length>1024*1024||!bytes.every((n:unknown)=>Number.isInteger(n)&&(n as number)>=0&&(n as number)<=255))throw Error('INVALID_PROOF');
 return {proposal:parsed.proposal,publisherParent:{...parent,authorityState:Uint8Array.from(bytes)}};
}

export function HouseholdAdultRemoval(){
 const workspace=useContext(LoroWorkspaceValue),app=useAppState(),service=workspace?.householdPairing?.adultRemoval;
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const [current,setCurrent]=useState<any>(null),[binding,setBinding]=useState(''),[bindings,setBindings]=useState('');
 const [message,setMessage]=useState(''),[review,setReview]=useState<any>(null),[fileReview,setFileReview]=useState<any>(null);
 const running=useRef(false);
 const target=useSyncExternalStore(subscribe,()=>workspace?pendingTargets.get(workspace)??null:null,empty);
 if(!workspace||!service||(!workspace.adultRemovalAccess&&!target))return null;
 const mutable=workspace.adultRemovalAccess==='mutable';
 function run(action:()=>Promise<void>){
  if(running.current)return;
  running.current=true;setBusy(true);setNotice('');
  void action().catch(error=>{
   const code=error instanceof Error?error.message:'';
   setNotice(code==='SOURCE_CHANGED'||code==='STALE_SOURCE'||code==='STALE_AUTHORITY'||code==='CONFLICT'?'The household or cooking changed. Refresh and prepare a new proposal.':
    code==='INVALID_FILE_SIZE'||code==='TOO_LARGE'?'The message or encrypted file is too large.':
    code==='REVIEW_CHANGED'?'The confirmation no longer matches the reviewed proposal. Review it again.':
    code==='INVALID_RECIPIENT'?'This file or binding is not addressed to an eligible device.':code||'Could not complete adult removal.');
  }).finally(()=>{running.current=false;setBusy(false)});
 }
 const button=(label:string,action:()=>Promise<void>,disabled=false)=><Pressable accessibilityRole="button" disabled={busy||disabled} onPress={()=>run(action)}><Text>{label}</Text></Pressable>;
 const copy=async(value:string)=>{if(!await copyText(value))throw Error('Copy the displayed message manually.');setNotice('Message copied.');};
 const showProposal=(proposal:any,checked:any,publisherParent?:any)=>{setMessage(proposalMessage(proposal,publisherParent));setReview({...checked,proposal,publisherParent});setFileReview(null);};
 async function transition(commit:()=>Promise<{head:string}>) {
  const release=app.beginWorkspaceTransition();
  let committed=false;
  try{
   await app.flushCurrentWorkspace();
   const result=await commit();committed=true;
   pending(workspace,{scopeId:workspace.household.scope.scopeId,head:result.head});
   setNotice('Saved. Reopen this household before editing or exchanging updates.');
  }finally{if(!committed)release();}
 }
 if(!open&&!target)return <Pressable accessibilityRole="button" onPress={()=>{setOpen(true);run(async()=>setCurrent(await service.status()));}}><Text>Remove an adult from the household recipe set</Text></Pressable>;
 return <View style={{gap:8}}>
  <Text accessibilityRole="header">Remove an adult from the household recipe set</Text>
  {!target&&button('Close recipe set removal',async()=>setOpen(false))}
  {target?<>
   <Text selectable>Removal saved. Editing remains paused until household {target.scopeId} reopens at {target.head}.</Text>
   {button('Reopen household after recipe set removal',async()=>{await workspace.reopen(target);})}
  </>:<>
   {current&&<>
    <Text selectable>Household {current.scope.id} · branch {current.head}</Text>
    {current.roster&&<Text selectable>Remaining or eligible adults: {current.roster.join(', ')}</Text>}
   </>}
   {workspace.adultRemovalAccess==='sponsor'&&current?.role==='sponsor'&&<>
    <Text>Save an encrypted file for each remaining device. You can return here to save a file again.</Text>
    {current.recipients.length===0&&<Text>No other devices need a file.</Text>}
    {current.recipients.map((id:string)=><View key={id} style={{gap:4}}>
     <Text selectable>Remaining device {id}</Text>
     {button(`Save recipe set removal file for ${id}`,async()=>{
      const release=await service.exportFile({operationId:current.operationId,recipientDeviceId:id});
      await saveExchangeFile(`creative-cooking-${id}.cc-adult-removal`,'application/octet-stream',encodeAdultRemovalRelease(release));
      setNotice('Encrypted file ready to share with this device.');
     })}
    </View>)}
   </>}
   {mutable&&<>
    <Text>Collect a signed binding from every remaining device. Share the public proposal with the adults who must approve it.</Text>
    {button('Create recipe set recipient binding',async()=>setBinding(JSON.stringify(await service.binding())))}
    {!!binding&&<>
     <Text selectable accessibilityLabel="Recipe set recipient binding">{binding}</Text>
     {button('Copy recipe set recipient binding',()=>copy(binding))}
     <PublicMessageFile label="recipe set recipient binding" limit={bindingLimit} outgoing={binding} run={run} disabled={busy}/>
    </>}
    <TextInput accessibilityLabel="Remaining recipe set device bindings" multiline editable={!busy} maxLength={bindingsLimit} value={bindings} onChangeText={setBindings} style={{borderWidth:1,padding:8,minHeight:64}}/>
    <PublicMessageFile label="remaining recipe set device binding" limit={bindingLimit} onRead={value=>{const next=[bindings,value].filter(Boolean).join('\n');if(new TextEncoder().encode(next).length>bindingsLimit)throw Error('TOO_LARGE');setBindings(next);}} run={run} disabled={busy}/>
    {current?.targets?.length===0&&<Text>There are no other adults to remove.</Text>}
    {current?.targets?.map((adult:any)=><View key={adult.adultId} style={{gap:4}}>
     <Text selectable>Adult {adult.adultId} · devices {adult.devices.join(', ')||'None active'}</Text>
     {button(`Prepare recipe set removal of adult ${adult.adultId}`,async()=>{
      await app.flushCurrentWorkspace();
      const parsed=bindings.split('\n').filter(line=>line.trim()).map(parseMessage);
      const result=await service.prepare({targetAdultId:adult.adultId,bindings:parsed,explicit:true});
      showProposal(result.proposal,result,result.publisherParent);
     })}
    </View>)}
    <TextInput accessibilityLabel="Signed recipe set removal proposal" multiline editable={!busy} maxLength={messageLimit} value={message} onChangeText={value=>{setMessage(value);setReview(null);setFileReview(null);}} style={{borderWidth:1,padding:8,minHeight:72}}/>
    <PublicMessageFile label="recipe set removal proposal" limit={messageLimit} onRead={value=>{setMessage(value);setReview(null);setFileReview(null);}} run={run} disabled={busy}/>
    {button('Review recipe set removal proposal',async()=>{const {proposal,publisherParent}=readProposal(message);const checked=await service.review({proposal,publisherParent});showProposal(proposal,checked,publisherParent);},!message)}
    {review&&<>
     <Text selectable>Parent branch {review.parentHead} · local authority revision {review.sourceRevision}</Text>
     <Text selectable>Adult to remove {review.excludedAdultId} · excluded devices {review.excludedDevices.join(', ')||'None active'}</Text>
     <Text selectable>Remaining devices {review.recipients.join(', ')}</Text>
     <Text>{review.approvals} of {review.required} required adult approvals.</Text>
     {button('Copy recipe set removal proposal',()=>copy(message))}
     <PublicMessageFile label="recipe set removal proposal" limit={messageLimit} outgoing={message} run={run} disabled={busy}/>
     {review.canApprove&&button('Approve recipe set removal',async()=>{const result=await service.approve({proposal:review.proposal,publisherParent:review.publisherParent,confirmed:review.confirmation,explicit:true});showProposal(result.proposal,result,review.publisherParent);})}
     {review.complete&&review.proposal.item.event.authorDeviceId===workspace.deviceId&&button('Confirm recipe set removal and publish',()=>transition(()=>service.publish({proposal:review.proposal,confirmed:review.confirmation,explicit:true})))}
    </>}
    {button('Choose encrypted recipe set removal file',async()=>{
     const bytes=await chooseExchangeFile({accept:['application/octet-stream','application/x-binary','.cc-adult-removal'],minBytes:21,maxBytes:MAX_ADULT_REMOVAL_FILE});
     if(!bytes)return;
     setFileReview(null);
     const release=decodeAdultRemovalRelease(bytes);
     const checked=await service.reviewFile({release});
     setFileReview({release,review:checked});
    })}
    {fileReview&&<>
     <Text>The public proposal was reviewed. The encrypted file is verified when you confirm installation.</Text>
     <Text selectable>Parent branch {fileReview.review.parentHead} · local authority revision {fileReview.review.sourceRevision}</Text>
     <Text selectable>Adult to remove {fileReview.review.excludedAdultId} · excluded devices {fileReview.review.excludedDevices.join(', ')||'None active'}</Text>
     <Text>{fileReview.review.approvals} of {fileReview.review.required} required adult approvals.</Text>
     {fileReview.review.complete&&fileReview.release.proposal.grant.recipients.includes(workspace.deviceId)&&fileReview.release.proposal.item.event.authorDeviceId!==workspace.deviceId&&
      button('Confirm install recipe set removal file',()=>transition(()=>service.install({release:fileReview.release,confirmed:fileReview.review.confirmation,sourceRevision:fileReview.review.sourceRevision,explicit:true})))}
     {button('Cancel recipe set removal file',async()=>setFileReview(null))}
    </>}
   </>}
   {button('Refresh recipe set removal status',async()=>setCurrent(await service.status()))}
  </>}
  {!!notice&&<Text accessibilityRole="alert">{notice}</Text>}
 </View>;
}
