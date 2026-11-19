import {useContext,useRef,useState} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import {useAppState} from '@/state/AppState';
import {LoroWorkspaceValue} from './WorkspaceStatus';
import {copyText} from './clipboard';
import {chooseExchangeFile} from './exchange-file';
import {PublicMessageFile} from './PublicMessageFile';
const limit=4*1024*1024,encoder=new TextEncoder();
const encode=(v:any)=>JSON.stringify(v,(_k,x)=>x instanceof Uint8Array?{__bytes:Array.from(x)}:x);
function decode(text:string){if(encoder.encode(text).length>limit)throw Error('The message is too large.');return JSON.parse(text,(_k,v)=>{if(v&&typeof v==='object'&&Object.keys(v).length===1&&Array.isArray(v.__bytes)){if(v.__bytes.length>limit||!v.__bytes.every((x:any)=>Number.isInteger(x)&&x>=0&&x<=255))throw Error('Invalid message bytes.');return Uint8Array.from(v.__bytes)}return v})}
/** Confirm each existing device before preparing its new household key. */
export function HouseholdExistingDevice(){
 const app=useAppState();
 const workspace=useContext(LoroWorkspaceValue),[open,setOpen]=useState(false),[role,setRole]=useState<'organizer'|'device'>('organizer'),[grant,setGrant]=useState(''),[identity,setIdentity]=useState(''),[offer,setOffer]=useState(''),[code,setCode]=useState(''),[output,setOutput]=useState(''),[peer,setPeer]=useState(''),[phase,setPhase]=useState(''),[evidence,setEvidence]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),session=useRef<any>(null),draft=useRef<any>(null);
 const run=async(fn:()=>Promise<void>)=>{setBusy(true);setStatus('');try{await fn()}catch(e){setStatus(e instanceof Error?e.message:'Could not verify the device.')}finally{setBusy(false)}};
 const clearVerification=()=>{session.current=null;setPhase('');setOutput('');setPeer('');setEvidence('')};
 const clear=()=>{clearVerification();draft.current=null};
 const show=(o:any)=>{setOutput(encode(o.ack??o.response??o.offer));setPhase(o.complete?'complete':o.ack?'ack':o.response?'response':'offer')};
 const prepare=async()=>{clear();const {item,prepared}=decode(grant),recipient=decode(identity),args={item,grant:prepared.grant,manifest:prepared.manifest,seed:prepared.seed,documents:prepared.documents,publisherParent:prepared.publisherParent},ceremony=await workspace.householdPairing.prepareExistingCeremony({...args,recipient,explicit:true});const text=encode({args,ceremony});if(encoder.encode(text).length>limit)throw Error('The proposed state is too large for this manual exchange.');draft.current={args,ceremony};setOffer(text);setCode('');setStatus('Share this message privately with that existing device. Compare the verification code separately.')};
 const begin=async()=>{const prior=draft.current;const x=decode(offer);let verified;if(role==='organizer'){if(!prior||encode(prior)!==encode(x))throw Error('Prepare this device message again.');if(code!==x.ceremony.oob.hash)throw Error('Verification code does not match.');verified=x.ceremony}else verified=await workspace.householdPairing.verifyExistingCeremony({...x.args,ceremony:x.ceremony,confirmedHash:code});const active=workspace.householdPairing.session({...verified,role:role==='organizer'?'initiator':'responder',confirmedHash:code});await active.initialize();const out=await active.outgoing();clearVerification();session.current=active;draft.current=x;show(out)};
 const advance=async()=>{if(!session.current)throw Error('Start verification first.');const incoming=decode(peer),out=await session.current.outgoing();if(out.revision===0)await session.current.respond(incoming,0);else if(out.revision===1)await session.current.acknowledge(incoming,1);else if(out.revision===2)await session.current.finish(incoming,2);else throw Error('Verification is already complete.');setPeer('');show(await session.current.outgoing())};
 const finish=async()=>{if(!session.current||!draft.current)throw Error('Start verification first.');const out=await session.current.outgoing();if(!out.complete)throw Error('Finish verification first.');const proof=await session.current.evidence(),c=draft.current.ceremony;setEvidence(encode({transcript:c.transcript,guard:c.guard,oob:c.oob,messages:proof.messages,context:c.context}));setStatus('Device verification evidence is ready. The new household key has not been installed yet.')};
 const copy=async(s:string)=>{if(!await copyText(s))throw Error('Could not copy. Copy the displayed text manually.');setStatus('Copied.')};
 const install=async()=>{
  const bytes=await chooseExchangeFile({accept:['application/octet-stream','application/x-binary'],minBytes:48,maxBytes:16*1024*1024+48});
  if(!bytes)return;
  const release=app.beginWorkspaceTransition();
  let reopening=false;
  try{
   await app.flushCurrentWorkspace();
   const result=await workspace.householdPairing.transfer.installExisting({bytes});
   if(result.acceptedHead===workspace.household.scope.branchHead){
    setStatus(`Household generation ${result.generation} is already open on this device.`);
    return;
   }
   workspace.reopen();
   reopening=true;
  }finally{if(!reopening)release()}
 };
 return <View style={{gap:8}}>
  <Pressable accessibilityRole="button" disabled={busy} onPress={()=>setOpen(!open)}>
   <Text>{open?'Close existing-device verification':'Verify an existing device'}</Text>
  </Pressable>
  {open?<>
   <Text>Verify this device against the organizer’s proposed household generation. Then open the encrypted file prepared for this device.</Text>
   <View style={{flexDirection:'row',gap:12}}>
    <Pressable accessibilityRole="button" disabled={busy} onPress={()=>{clear();setRole('organizer')}}><Text>Organize device verification</Text></Pressable>
    <Pressable accessibilityRole="button" disabled={busy} onPress={()=>{clear();setRole('device')}}><Text>Verify this existing device</Text></Pressable>
   </View>
   {role==='organizer'?<>
    <TextInput accessibilityLabel="Collected grant for existing device" editable={!busy} multiline maxLength={limit} value={grant} onChangeText={v=>{clear();setGrant(v)}} style={{borderWidth:1,padding:8}}/>
    <TextInput accessibilityLabel="Existing device public identity" editable={!busy} multiline maxLength={limit} value={identity} onChangeText={v=>{clear();setIdentity(v)}} style={{borderWidth:1,padding:8}}/>
    <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(prepare)}><Text>Prepare existing-device verification</Text></Pressable>
    {offer&&draft.current?<><Text selectable accessibilityLabel="Existing-device verification message">{offer}</Text>
     <Text selectable accessibilityLabel="Existing-device verification code">{draft.current.ceremony.oob.hash}</Text>
     <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(()=>copy(offer))}><Text>Copy existing-device message</Text></Pressable>
     <PublicMessageFile label="existing-device verification" limit={limit} outgoing={offer} run={run} disabled={busy}/>
    </>:null}
   </>:<>
    <TextInput accessibilityLabel="Existing-device verification message input" editable={!busy} multiline maxLength={limit} value={offer} onChangeText={v=>{clear();setOffer(v)}} style={{borderWidth:1,padding:8}}/>
    <PublicMessageFile label="existing-device verification" limit={limit} onRead={v=>{clear();setOffer(v)}} run={run} disabled={busy}/>
   </>}
   <TextInput accessibilityLabel="Confirmed existing-device code" editable={!busy} maxLength={128} value={code} onChangeText={v=>{clearVerification();setCode(v)}} placeholder="Code compared separately" style={{borderWidth:1,padding:8}}/>
   <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(begin)}><Text>Start existing-device verification</Text></Pressable>
   {phase?<><Text>{phase==='complete'?'Existing-device verification complete.':`Exchange the ${phase} with the other device.`}</Text>
    <Text selectable accessibilityLabel="Existing-device outgoing message">{output}</Text>
    <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(()=>copy(output))}><Text>Copy device verification message</Text></Pressable>
    <PublicMessageFile label="device verification message" limit={limit} outgoing={output} run={run} disabled={busy}/>
    {phase!=='complete'?<>
     <TextInput accessibilityLabel="Other existing-device message" editable={!busy} multiline maxLength={limit} value={peer} onChangeText={setPeer} style={{borderWidth:1,padding:8}}/>
     <PublicMessageFile label="device verification message" limit={limit} onRead={setPeer} run={run} disabled={busy}/>
     <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(advance)}><Text>Continue existing-device verification</Text></Pressable>
    </>:role==='organizer'?<Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(finish)}><Text>Show existing-device evidence</Text></Pressable>:null}
   </>:null}
   {evidence?<><Text selectable accessibilityLabel="Existing-device evidence">{evidence}</Text>
    <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(()=>copy(evidence))}><Text>Copy existing-device evidence</Text></Pressable>
    <PublicMessageFile label="existing-device evidence" limit={limit} outgoing={evidence} run={run} disabled={busy}/>
   </>:null}
   {role==='device'?<>
    <Text>After verifying this device, choose its encrypted file to open the new generation. Edits from the previous generation stay on this device in that generation.</Text>
    <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(install)}><Text>Install and open household generation</Text></Pressable>
   </>:null}
   {status?<Text accessibilityRole="alert">{status}</Text>:null}
  </>:null}
 </View>;
}
