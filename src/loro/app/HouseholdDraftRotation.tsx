import {useContext,useRef,useState,useSyncExternalStore} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import {useAppState} from '@/state/AppState';
import {LoroWorkspaceValue} from './WorkspaceStatus';
import {PublicMessageFile} from './PublicMessageFile';
import {copyText} from './clipboard';
import {chooseExchangeFile,saveExchangeFile} from './exchange-file';
import {MAX_DRAFT_ROTATION_FILE} from '../pairing/draft-rotation-wire.mjs';

const limit=16*1024*1024, bindingLimit=128*1024;
type Target={scopeId:string;head:string};
const targets=new WeakMap<object,Target>(),listeners=new Set<()=>void>();
const subscribe=(f:()=>void)=>{listeners.add(f);return()=>{listeners.delete(f)};};
const empty=()=>null;
function encode(proposal:any,parent:any){return JSON.stringify({version:1,proposal,publisherParent:{...parent,authorityState:Array.from(parent.authorityState)}});}
function decode(text:string){const value=JSON.parse(text),bytes=value?.publisherParent?.authorityState;if(value?.version!==1||!Array.isArray(bytes)||!bytes.length||bytes.length>1024*1024||!bytes.every((n:unknown)=>Number.isInteger(n)&&(n as number)>=0&&(n as number)<=255))throw Error('INVALID_PROPOSAL');return {proposal:value.proposal,publisherParent:{...value.publisherParent,authorityState:Uint8Array.from(bytes)}};}
export function HouseholdDraftRotation(){
 const workspace=useContext(LoroWorkspaceValue),app=useAppState(),service=workspace?.householdPairing?.draftRotation;
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[session,setSession]=useState<any>(null),[draft,setDraft]=useState<any>(null),[bindings,setBindings]=useState(''),[binding,setBinding]=useState(''),[message,setMessage]=useState(''),[review,setReview]=useState<any>(null),[fileReview,setFileReview]=useState<any>(null),[status,setStatus]=useState<any>(null);
 const running=useRef(false),target=useSyncExternalStore(subscribe,()=>workspace?targets.get(workspace)??null:null,empty);
 if(!workspace||!service||(!workspace.draftRotationAccess&&!target))return null;
 const mutable=workspace.draftRotationAccess==='mutable';
 function run(action:()=>Promise<void>){if(running.current)return;running.current=true;setBusy(true);setNotice('');void action().catch(e=>setNotice(e instanceof Error?e.message:'Could not complete device revocation.')).finally(()=>{running.current=false;setBusy(false)});}
 const button=(label:string,action:()=>Promise<void>,disabled=false)=><Pressable accessibilityRole="button" disabled={busy||disabled} onPress={()=>run(action)}><Text>{label}</Text></Pressable>;
 const show=(result:any)=>{setMessage(encode(result.proposal,result.publisherParent));setReview(result);};
 const change=(value:string)=>{setMessage(value);setReview(null);};
 async function transition(commit:()=>Promise<{head:string}>){const release=app.beginWorkspaceTransition();let committed=false;try{await app.flushCurrentWorkspace();const result=await commit();committed=true;targets.set(workspace,{scopeId:workspace.household.scope.scopeId,head:result.head});listeners.forEach(f=>f());}finally{if(!committed)release();}}
 if(!open&&!target)return <Pressable accessibilityRole="button" onPress={()=>{setOpen(true);run(async()=>{if(mutable)setSession(await workspace.householdCompromise.selected.open());else setStatus(await service.status());});}}><Text>Publish device revocation from local draft</Text></Pressable>;
 return <View style={{gap:8}}><Text accessibilityRole="header">Publish device revocation from local draft</Text>
 {target?<><Text selectable>Editing is paused until household {target.scopeId} reopens at {target.head}.</Text>{button('Reopen household after device revocation',async()=>{await workspace.reopen(target);})}</>:<>
 {button('Close draft revocation',async()=>setOpen(false))}
 {status&&<>{status.recipients.length===0&&<Text>No other devices need a file.</Text>}{status.recipients.map((id:string)=><View key={id}><Text selectable>Remaining device {id}</Text>{button(`Save device revocation file for ${id}`,async()=>{const bytes=await service.exportFile({operationId:status.operationId,recipientDeviceId:id});await saveExchangeFile(`creative-cooking-${id}.cc-draft-rotation`,'application/octet-stream',bytes);})}</View>)}</>}
 {mutable&&<>
 <Text>Choose a verified local draft and collect a binding from each remaining device. Share the public proposal for approval.</Text>
 {session?.draftIds.map((id:string)=>button(`Choose revocation draft ${id}`,async()=>setDraft(await workspace.householdCompromise.selected.reopenDraft(session.confirmation,id))))}
 {draft&&<Text selectable>Selected local draft {draft.draftId}</Text>}
 {button('Create device revocation recipient binding',async()=>setBinding(JSON.stringify(await service.binding())))}
 {!!binding&&<><Text selectable>{binding}</Text>{button('Copy device revocation recipient binding',async()=>{if(!await copyText(binding))throw Error('Copy failed');})}<PublicMessageFile label="device revocation recipient binding" limit={bindingLimit} outgoing={binding} run={run} disabled={busy}/></>}
 <TextInput accessibilityLabel="Remaining device revocation bindings" multiline value={bindings} onChangeText={setBindings} style={{borderWidth:1,padding:8}}/>
 <PublicMessageFile label="remaining device revocation binding" limit={bindingLimit} onRead={v=>setBindings(x=>[x,v].filter(Boolean).join('\n'))} run={run} disabled={busy}/>
 {button('Prepare device revocation proposal',async()=>{await app.flushCurrentWorkspace();show(await service.prepare({draftId:draft.draftId,bindings:bindings.split('\n').filter(x=>x.trim()).map(x=>JSON.parse(x)),explicit:true}));},!draft)}
 <TextInput accessibilityLabel="Device revocation proposal" multiline value={message} onChangeText={change} style={{borderWidth:1,padding:8}}/>
 <PublicMessageFile label="device revocation proposal" limit={limit} onRead={change} run={run} disabled={busy}/>
 {button('Review device revocation proposal',async()=>{const input=decode(message);setReview({...await service.review(input),...input});},!message)}
 {review&&<><Text selectable>Parent {review.parentHead} · reported device {review.suspectDevice}</Text><Text selectable>Remaining devices {review.recipients.join(', ')}</Text><Text>{review.approvals} of {review.required} required approvals.</Text>
 {button('Copy device revocation proposal',async()=>{if(!await copyText(message))throw Error('Copy failed');})}<PublicMessageFile label="device revocation proposal" limit={limit} outgoing={message} run={run} disabled={busy}/>
 {review.canApprove&&button('Approve device revocation',async()=>show(await service.approve({proposal:review.proposal,publisherParent:review.publisherParent,confirmed:review.confirmation,explicit:true})))}
 {review.complete&&draft&&review.proposal.item.event.authorDeviceId===workspace.deviceId&&button('Confirm device revocation and publish',()=>transition(()=>service.publish({draftId:draft.draftId,proposal:review.proposal,confirmed:review.confirmation,explicit:true})))}
 </>}
 {button('Choose encrypted device revocation file',async()=>{setFileReview(null);const file=await chooseExchangeFile({accept:['application/octet-stream','.cc-draft-rotation'],minBytes:21,maxBytes:MAX_DRAFT_ROTATION_FILE});if(file)setFileReview({file,review:await service.reviewFile({file})});})}
 {fileReview&&<><Text selectable>Reviewed file for this device · parent {fileReview.review.parentHead} · reported device {fileReview.review.suspectDevice}</Text>{button('Confirm install device revocation file',()=>transition(()=>service.install({file:fileReview.file,confirmed:fileReview.review.confirmation,sourceRevision:fileReview.review.sourceRevision,explicit:true})))}{button('Cancel device revocation file',async()=>setFileReview(null))}</>}
 </>}</>}{!!notice&&<Text accessibilityRole="alert">{notice}</Text>}</View>;
}
