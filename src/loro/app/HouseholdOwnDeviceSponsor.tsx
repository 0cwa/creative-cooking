import {useContext,useRef,useState} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import {useAppState} from '@/state/AppState';
import {LoroWorkspaceValue} from './WorkspaceStatus';
import {PublicMessageFile} from './PublicMessageFile';
import {copyText} from './clipboard';
import {saveExchangeFile} from './exchange-file';
import {MAX_HOUSEHOLD_OWN_DEVICE_MESSAGE as limit} from './household-own-device.mjs';

const encode=(value:any)=>JSON.stringify(value,(_key,v)=>v instanceof Uint8Array?{__bytes:Array.from(v)}:v);
const decode=(text:string)=>{
 if(new TextEncoder().encode(text).length>limit)throw Error('The message is too large.');
 return JSON.parse(text,(_key,v)=>{
  if(v&&typeof v==='object'&&Object.keys(v).length===1&&Array.isArray(v.__bytes)){
   if(v.__bytes.length>limit||!v.__bytes.every((x:any)=>Number.isInteger(x)&&x>=0&&x<=255))throw Error('Invalid message bytes.');
   return Uint8Array.from(v.__bytes);
  }
  return v;
 });
};
type Completed={offer:any;identity:any;session:any};
export function HouseholdOwnDeviceSponsor({code,newcomerId,onLocked,onDraft}:{code:string;newcomerId:string;onLocked:(value:boolean)=>void;onDraft:(value:boolean)=>void}){
 const workspace=useContext(LoroWorkspaceValue),app=useAppState(),pairing=workspace.householdPairing,service=pairing.ownDevice;
 const [prepared,setPrepared]=useState<any>(null),[identityText,setIdentityText]=useState(''),[offer,setOffer]=useState<any>(null),[confirmed,setConfirmed]=useState(''),[peer,setPeer]=useState(''),[out,setOut]=useState(''),[phase,setPhase]=useState(''),[completed,setCompleted]=useState<Record<string,Completed>>({}),[release,setRelease]=useState<any>(null),[attempted,setAttempted]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const working=useRef(false),active=useRef<any>(null),paused=useRef<null|(()=>void)>(null);
 const clearActive=()=>{active.current=null;setOffer(null);setConfirmed('');setPeer('');setOut('');setPhase('')};
 const run=(fn:()=>Promise<void>)=>{if(working.current)return;working.current=true;setBusy(true);setNotice('');void fn().catch((e:Error)=>setNotice(e.message==='SOURCE_CHANGED'||e.message==='CONFLICT'?'Household edits or authority changed after the copy was prepared. Keep those edits and prepare a fresh pairing; no changes were overwritten.':e.message||'Could not continue household pairing.')).finally(()=>{working.current=false;setBusy(false)})};
 const button=(label:string,fn:()=>Promise<void>,disabled=false)=><Pressable accessibilityRole="button" disabled={busy||disabled} onPress={()=>run(fn)}><Text>{label}</Text></Pressable>;
 const field=(label:string,value:string,change:(v:string)=>void,multiline=false)=><TextInput accessibilityLabel={label} value={value} onChangeText={change} multiline={multiline} maxLength={multiline?limit:128} editable={!busy&&!attempted} autoCapitalize="none" autoCorrect={false}/>;
 const output=(label:string,value:string)=><><TextInput accessibilityLabel={label} value={value} multiline editable={false}/><PublicMessageFile label={label.toLowerCase()} outgoing={value} limit={limit} run={run} disabled={busy}/>{button('Copy '+label.toLowerCase(),async()=>{if(!await copyText(value))throw Error('Could not copy the message.')})}</>;
 const show=(value:any)=>{setOut(encode(value.ack??value.response??value.offer));setPhase(value.complete?'complete':value.ack?'ack':value.response?'response':'offer')};
 const prepare=async()=>{clearActive();setPrepared(null);setCompleted({});onDraft(false);const result=await service.prepareSet(code);setPrepared(result);onDraft(true);setNotice('Copy prepared. Verify every required existing device before publishing.')};
 const prepareOffer=async()=>{clearActive();const identity=decode(identityText);setCompleted(previous=>{const next={...previous};delete next[identity?.deviceId];return next});const result=await service.prepareEstablishedOffer(code,identity);if(!prepared||!prepared.requiredRecipientIds.includes(result.context.recipientDeviceId)||result.context.admissionEventHash!==prepared.transition.head)throw Error('The offer does not match the prepared copy.');setCompleted(previous=>{const next={...previous};delete next[result.context.recipientDeviceId];return next});active.current={identity,offer:result,session:null};setOffer(result)};
 const begin=async()=>{const draft=active.current;if(!draft||!offer||encode(draft.offer)!==encode(offer)||confirmed.trim()!==offer.oob.hash)throw Error('The independently compared offer code does not match.');setOut('');setPhase('');setPeer('');draft.session=null;const fresh=await service.prepareEstablishedOffer(code,draft.identity);if(encode(fresh)!==encode(offer))throw Error('The offer changed. Prepare it again.');const session=pairing.session({...fresh,role:'initiator',confirmedHash:confirmed.trim()});await session.initialize();const result=await session.outgoing();draft.session=session;show(result);if(result.complete){await session.evidence();setCompleted(previous=>({...previous,[fresh.context.recipientDeviceId]:{offer:fresh,identity:draft.identity,session}}))}};
 const advance=async()=>{const draft=active.current,s=draft?.session;if(!s)throw Error('Confirm this offer first.');const current=await s.outgoing(),message=decode(peer);if(current.revision===0)await s.respond(message,0);else if(current.revision===1)await s.acknowledge(message,1);else if(current.revision===2)await s.finish(message,2);else throw Error('Verification is already complete.');setPeer('');const result=await s.outgoing();show(result);if(result.complete){await s.evidence();setCompleted(previous=>({...previous,[draft.offer.context.recipientDeviceId]:{offer:draft.offer,identity:draft.identity,session:s}}));setNotice('Device verified. Repeat for each remaining recipient.')}};
 const allComplete=!!prepared&&prepared.requiredRecipientIds.every((id:string)=>!!completed[id]);
 const publish=async()=>{
  if(!prepared||!allComplete)throw Error('Verify every required device first.');
  let newlyPaused=false;
  if(!paused.current){paused.current=app.beginWorkspaceTransition();newlyPaused=true;onLocked(true)}
  let invoking=false;
  try{
   if(newlyPaused)await app.flushCurrentWorkspace();
   if(!attempted){const fresh=await service.prepareSet(code);if(encode(fresh)!==encode(prepared))throw Error('SOURCE_CHANGED')}
   const proofs=[];
   for(const id of prepared.requiredRecipientIds){const entry=completed[id];if(!entry||entry.offer.context.recipientDeviceId!==id||entry.offer.context.admissionEventHash!==prepared.transition.head||!(await entry.session.outgoing()).complete)throw Error('The device verification changed. Prepare the copy again.');if(!attempted){const fresh=await service.prepareEstablishedOffer(code,entry.identity);if(encode(fresh)!==encode(entry.offer))throw Error('The device offer changed. Prepare the copy again.')}proofs.push({context:entry.offer.context,transcript:entry.offer.transcript,guard:entry.offer.guard,oob:entry.offer.oob,messages:(await entry.session.evidence()).messages})}
   invoking=true;setAttempted(true);
   const result=await service.publishPreparedSet(code,proofs);
   if(result.head!==prepared.transition.head||encode(result.establishedRecipients.map((entry:any)=>entry.recipientDeviceId).sort())!==encode([...prepared.requiredRecipientIds].sort()))throw Error('The retained release does not match the prepared recipients. Retry publication.');
   setRelease(result);setNotice('Household published. Export each encrypted file for its labeled device. Editing stays paused until reopening.');
  }catch(error){
   if(invoking){
    let retained:any;
    try{retained=await service.recoverPreparedSet(code)}catch{throw Error('Publication may have completed. Editing remains paused; retry publication to recover the retained files.')}
    if(retained){setRelease(retained);setNotice('Publication completed. The verified retained files are ready to export.');return}
    setAttempted(false);
   }
   if(invoking||newlyPaused){paused.current?.();paused.current=null;onLocked(false)}
   throw error;
  }
 };
 const recover=async()=>{const finish=app.beginWorkspaceTransition();let held=false;try{await app.flushCurrentWorkspace();const result=await service.recoverPreparedSet(code);if(!result)throw Error('No retained household release was found for this pairing.');if(result.head!==workspace.household.scope.branchHead){paused.current=finish;held=true;onLocked(true)}setRelease(result);setAttempted(true);setNotice('Verified retained files are ready to export.')}finally{if(!held)finish()}};
 return <View style={{gap:8}}>
  <Text>Prepare a copy for the new device and verify every existing recipient separately. No recipes or keys are included in the public messages.</Text>
  {button('Prepare household copy for all devices',prepare,attempted)}
  {button('Recover retained paired-household files',recover,attempted||!!prepared)}
  {prepared?<><Text accessibilityLabel="Required paired-household recipients">Required existing devices: {prepared.requiredRecipientIds.length?prepared.requiredRecipientIds.join(' · '):'none'}</Text>
   {prepared.requiredRecipientIds.map((id:string)=><Text key={id} accessibilityLabel={`Paired-household recipient ${id}`}>{id}: {completed[id]?'verified':'verification required'}</Text>)}
   {!attempted&&prepared.requiredRecipientIds.length? <>
    {field('Existing paired-household device identity',identityText,v=>{clearActive();setIdentityText(v)},true)}
    <PublicMessageFile label="existing household device public identity" limit={limit} onRead={v=>{clearActive();setIdentityText(v)}} run={run} disabled={busy}/>
    {button('Prepare paired-household recipient offer',prepareOffer,!identityText)}
    {offer?<>{output('Paired-household recipient offer',offer.text)}<Text selectable accessibilityLabel="Paired-household recipient code">{offer.oob.hash}</Text><Text>Compare this code independently with the existing device.</Text>
     {field('Confirmed paired-household recipient code',confirmed,v=>{if(active.current){active.current.session=null;const id=active.current.offer.context.recipientDeviceId;setCompleted(previous=>{const next={...previous};delete next[id];return next})}setOut('');setPhase('');setConfirmed(v)})}
     {button('Confirm paired-household recipient code',begin,!confirmed)}
     {phase?<><Text>{phase==='complete'?'Recipient verification complete.':`Exchange the ${phase} message with this recipient.`}</Text>{output('Sponsor paired-household verification message',out)}
      {phase!=='complete'?<>{field('Incoming sponsor paired-household verification message',peer,setPeer,true)}<PublicMessageFile label="paired-household verification message" limit={limit} onRead={setPeer} run={run} disabled={busy}/>{button('Accept sponsor paired-household verification message',advance,!peer)}</>:null}</>:null}
    </>:null}
   </>:null}
   {!release?button(attempted?'Retry household publication':'Publish household copy for all devices',publish,!allComplete):null}
  </>:null}
  {release?<><Text>Export each encrypted file separately to its named device. You can retry any export.</Text>
   {button(`Export newcomer household file for ${newcomerId}`,async()=>{await saveExchangeFile(`creative-cooking-newcomer-${newcomerId.replace(/[^a-zA-Z0-9_-]/g,'_')}.cchouse`,'application/octet-stream',release.file);setNotice('Newcomer file ready to share.')})}
   {release.establishedRecipients.map((entry:any)=><View key={entry.recipientDeviceId}>{button(`Export household file for ${entry.recipientDeviceId}`,async()=>{if(!(entry.ciphertext instanceof Uint8Array)||release.establishedRecipients.filter((x:any)=>x.recipientDeviceId===entry.recipientDeviceId).length!==1)throw Error('The retained file does not match a verified recipient.');await saveExchangeFile(`creative-cooking-device-${entry.recipientDeviceId.replace(/[^a-zA-Z0-9_-]/g,'_')}.cchouse`,'application/octet-stream',entry.ciphertext);setNotice(`File for ${entry.recipientDeviceId} ready to share.`)})}</View>)}
   {release.head!==workspace.household.scope.branchHead?button('Reopen published paired household',async()=>{workspace.reopen({scopeId:workspace.household.scope.scopeId,head:release.head})}):null}
  </>:null}
  {notice?<Text accessibilityRole="alert">{notice}</Text>:null}
 </View>;
}
