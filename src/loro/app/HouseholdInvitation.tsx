import {useContext,useEffect,useRef,useState} from 'react';
import {Platform,Pressable,Text,TextInput,View} from 'react-native';
import {copyText} from './clipboard';
import {useAppState} from '@/state/AppState';
import {chooseExchangeFile,saveExchangeFile} from './exchange-file';
import {PublicMessageFile} from './PublicMessageFile';
import {LoroWorkspaceValue} from './WorkspaceStatus';
const limit=1024*1024,grantLimit=4*1024*1024,encoder=new TextEncoder();
const encode=(v:any)=>JSON.stringify(v,(_k,x)=>x instanceof Uint8Array?{__bytes:Array.from(x)}:x);
function decode(text:string,max=limit){if(encoder.encode(text).length>max)throw Error('The pasted message is too large.');return JSON.parse(text,(_k,v)=>{if(v&&typeof v==='object'&&Object.keys(v).length===1&&Array.isArray(v.__bytes)){if(v.__bytes.length>max||!v.__bytes.every((x:any)=>Number.isInteger(x)&&x>=0&&x<=255))throw Error('Invalid message bytes.');return Uint8Array.from(v.__bytes)}return v})}
type PublishedFiles = {operationId: string; generation: number; recipients: {recipientDevice: string; joining: boolean}[]};

/** Assemble signed admission evidence and exchange recipient-specific files. */
export function HouseholdInvitation(){
 const app=useAppState();
 const workspace=useContext(LoroWorkspaceValue),[open,setOpen]=useState(false),[role,setRole]=useState<'organizer'|'recipient'>('organizer'),[identityText,setIdentityText]=useState(''),[offerText,setOfferText]=useState(''),[recoveryText,setRecoveryText]=useState(''),[code,setCode]=useState(''),[peer,setPeer]=useState(''),[output,setOutput]=useState(''),[phase,setPhase]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false),[published,setPublished]=useState(false);
 const session=useRef<any>(null),draft=useRef<any>(null),verified=useRef<any>(null),offer=useRef<any>(null);
 const [grantText,setGrantText]=useState(''),[existingText,setExistingText]=useState('');
 const [existingEvidence,setExistingEvidence]=useState<Record<string,any>>({});
 const [files,setFiles]=useState<PublishedFiles|null>(null);
 const expectedExisting:string[]=workspace.household.scope.acceptedRecipients.filter((device:string)=>device!==workspace.deviceId);
 useEffect(()=>{
  if(!open||role!=='organizer')return;
  let current=true;
  void workspace.householdPairing.transfer.publishedFiles().then((value:PublishedFiles|null)=>{if(current)setFiles(value)},(error:Error)=>{if(current)setStatus(error.message)});
  return ()=>{current=false};
 },[open,role,workspace]);
 const run=async(fn:()=>Promise<void>)=>{setBusy(true);setStatus('');try{await fn()}catch(e){setStatus(e instanceof Error?e.message:'The invitation step failed.')}finally{setBusy(false)}};
 const bounded=(text:string,set:(v:string)=>void)=>{if(encoder.encode(text).length>limit){setStatus('The pasted message is too large.');return}set(text);setStatus('')};
 const copy=async(text:string)=>{if(!await copyText(text))throw Error('Could not copy. Copy the displayed text manually.');setStatus('Copied.')};
 const displayOutgoing=(out:any)=>{setOutput(encode(out.ack??out.response??out.offer));setPhase(out.complete?'complete':out.ack?'ack':out.response?'response':'offer')};
 const refresh=async()=>displayOutgoing(await session.current.outgoing());
 const prepareOffer=async(item:any,prepared:any)=>{
  const ceremony=await workspace.householdPairing.prepareCeremony({item,grant:prepared.grant,manifest:prepared.manifest,seed:prepared.seed,explicit:true});
  const scope=ceremony.transcript.scope;
  offer.current={scope,item,grant:prepared.grant,ceremony};
  draft.current={item,prepared,ceremony,offer:offer.current};
  session.current=null;
  setOfferText(encode(offer.current));setCode('');setPhase('');setOutput('');setPeer('');setExistingEvidence({});setExistingText('');
  setStatus('Share the latest public authority first. Compare its root and head independently, then share the invitation and compare the verification code separately.');
 };
 const prepare=async()=>{
  if(expectedExisting.length)throw Error('Use the collected cooking grant to prepare an invitation for this household.');
  const recipient=decode(identityText),delegation=await workspace.householdPairing.prepareDelegation({explicit:true});
  if(delegation.requiredAdults.length!==1)throw Error('Collect signatures for the current-cooking agreement first.');
  const {item}=await workspace.householdPairing.prepareInvite({recipient,explicit:true});
  await workspace.householdPairing.acceptDelegation({agreement:{...delegation.agreement,acceptances:[delegation.acceptance]},explicit:true});
  await prepareOffer(item,await workspace.householdPairing.prepareGrant({item,explicit:true}));
 };
 const prepareCollected=async()=>{
  const {item,prepared}=decode(grantText,grantLimit);
  await prepareOffer(item,prepared);
 };
 const collectExisting=async()=>{
  if(!draft.current)throw Error('Prepare the invitation first.');
  const proof=decode(existingText),device=proof?.context?.recipientDeviceId,ceremony=draft.current.ceremony;
  if(!expectedExisting.includes(device)||proof.context.admissionEventHash!==ceremony.context.admissionEventHash||proof.transcript?.authorizationSnapshot!==ceremony.transcript.authorizationSnapshot)throw Error('The device evidence belongs to a different invitation or household.');
  const completed=await workspace.householdPairing.transfer.completedProof(proof);
  setExistingEvidence(previous=>({...previous,[device]:completed}));
  setExistingText('');
 };
 const begin=async()=>{
  session.current=null;verified.current=null;setPhase('');setOutput('');setPeer('');
  const supplied=code.trim();let nextOffer:any=null,nextVerified:any=null,nextSession:any;
  if(role==='recipient'){
   offer.current=null;
   nextOffer=decode(offerText);
   nextVerified=await workspace.householdPairing.verifyOffer({offer:nextOffer,confirmedHash:supplied});
   nextSession=workspace.householdPairing.session({...nextVerified,role:'responder',confirmedHash:supplied});
  }else{
   if(!draft.current)throw Error('Prepare the invitation first.');
   const c=draft.current.ceremony;
   if(supplied!==c.oob.hash)throw Error('The verification code does not match.');
   nextSession=workspace.householdPairing.session({transcript:c.transcript,guard:c.guard,oob:c.oob,role:'initiator',confirmedHash:supplied});
  }
  await nextSession.initialize();
  const outgoing=await nextSession.outgoing();
  if(role==='recipient'){offer.current=nextOffer;verified.current=nextVerified}
  session.current=nextSession;displayOutgoing(outgoing);
 };
 const advance=async()=>{if(!session.current)throw Error('Start verification first.');const incoming=decode(peer),state=await session.current.outgoing();if(!state.response)await session.current.respond(incoming,state.revision);else if(!state.ack)await session.current.acknowledge(incoming,state.revision);else if(!state.complete)await session.current.finish(incoming,state.revision);else throw Error('Verification is already complete.');setPeer('');await refresh()};
 const saveFile=async(bytes:Uint8Array)=>{await saveExchangeFile('creative-cooking-household.bin','application/octet-stream',bytes);setStatus('Encrypted household file prepared. Give it to the verified recipient.')};
 const savePublished=async(operationId:string,recipientDevice:string)=>saveFile(await workspace.householdPairing.transfer.seal({operationId,recipientDevice}));
 const recoverFile=async()=>{const prior=decode(recoveryText),operationId=prior?.item?.event?.proposalId,recipientDevice=prior?.item?.event?.subject?.devices?.[0]?.deviceId;if(typeof operationId!=='string'||typeof recipientDevice!=='string')throw Error('The invitation message is invalid.');await saveFile(await workspace.householdPairing.transfer.seal({operationId,recipientDevice}))};
 const publishAndShare=async()=>{
  if(!draft.current||!session.current)throw Error('Prepare and verify the invitation first.');
  const state=await session.current.outgoing();
  if(!state.complete)throw Error('Finish device verification first.');
  if(expectedExisting.some(device=>!existingEvidence[device]))throw Error('Collect completed verification evidence for every existing device.');
  const {item,prepared,ceremony}=draft.current,evidence=await session.current.evidence();
  const {transcript,guard,oob,context}=ceremony;
  const result=await workspace.householdPairing.transfer.publish({item,grant:prepared.grant,manifest:prepared.manifest,seed:prepared.seed,policyBundle:prepared.policyBundle,ceremonies:[{transcript,guard,oob,context,messages:evidence.messages}],existingCeremonies:expectedExisting.map(device=>existingEvidence[device])});
  setPublished(true);
  setFiles(await workspace.householdPairing.transfer.publishedFiles());
  if(expectedExisting.length) setStatus(`Household generation ${item.event.subject.newGeneration} ${result.replayed?'was already published':'was published'}. Share each encrypted file with its named device.`);
  else await savePublished(result.operationId,context.recipientDeviceId);
 };
 const download=async()=>{
  const release=app.beginWorkspaceTransition();
  try{await app.flushCurrentWorkspace();await publishAndShare()}finally{release()}
 };
 const reopen=async()=>{
  const release=app.beginWorkspaceTransition();
  try{await app.flushCurrentWorkspace();workspace.reopen()}catch(error){release();throw error}
 };
 const install=async()=>{
  if(!verified.current||!session.current||(await session.current.outgoing()).complete!==true)throw Error('Finish device verification first.');
  const bytes=await chooseExchangeFile({accept:['application/octet-stream','application/x-binary'],minBytes:48,maxBytes:16*1024*1024+48});
  if(!bytes)return;
  const result=await workspace.householdPairing.transfer.install({scope:offer.current.scope,bytes});
  setStatus(result.replayed?'This household was already installed. Open it using the confirmed household control.':'Household installed. Your current household is still open; use the confirmed household control to switch.');
 };

 const noun=Platform.OS==='web'?'Download':'Share';
 return <View style={{gap:8}}>
  <Pressable accessibilityRole="button" onPress={()=>setOpen(!open)}><Text>{open?'Close household invitation':'Invite or join a household'}</Text></Pressable>
  {open?<><Text accessibilityRole="header">Household invitation</Text>
   <View style={{flexDirection:'row',gap:12}}>
    <Pressable accessibilityRole="button" disabled={busy} onPress={()=>{setRole('organizer');setPhase('');session.current=null}}><Text>Organize invitation</Text></Pressable>
    <Pressable accessibilityRole="button" disabled={busy} onPress={()=>{setRole('recipient');setPhase('');session.current=null}}><Text>Join invitation</Text></Pressable>
   </View>
   {role==='organizer'?<>
    {expectedExisting.length?<>
     <Text>Collect the required adult approvals, retain the agreement from every adult and collect the required signatures on the current-cooking grant. Paste that grant here to prepare the invitation. Share the grant privately with existing household adults.</Text>
     <TextInput accessibilityLabel="Collected grant for invitation" editable={!busy} multiline maxLength={grantLimit} value={grantText} onChangeText={setGrantText} style={{borderWidth:1,padding:8}}/>
     <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(prepareCollected)}><Text>Prepare invitation from collected grant</Text></Pressable>
    </>:<>
     <Text>Paste the recipient’s public device identity. Preparing an invitation approves sharing current recipes, pantry and shopping.</Text>
     <TextInput accessibilityLabel="Recipient public identity" multiline maxLength={limit} value={identityText} onChangeText={v=>bounded(v,setIdentityText)} style={{borderWidth:1,padding:8}}/>
     <PublicMessageFile label="device identity" limit={limit} onRead={setIdentityText} run={run} disabled={busy}/>
     <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(prepare)}><Text>Prepare current-cooking invitation</Text></Pressable>
    </>}
    {draft.current?<><Text>Verification code to compare separately</Text>
     <Text selectable accessibilityLabel="Invitation verification code">{draft.current.ceremony.oob.hash}</Text>
     <Text selectable accessibilityLabel="Public invitation message">{encode(draft.current.offer)}</Text>
     <Pressable accessibilityRole="button" onPress={()=>void run(()=>copy(encode(draft.current.offer)))}><Text>Copy public invitation message</Text></Pressable>
     <PublicMessageFile label="invitation" limit={limit} outgoing={encode(draft.current.offer)} run={run} disabled={busy}/>
     {expectedExisting.length?<><Text>Use the existing-device verification controls below. Collect the completed evidence here for each device.</Text>
      <TextInput accessibilityLabel="Completed existing-device evidence" editable={!busy} multiline maxLength={limit} value={existingText} onChangeText={v=>bounded(v,setExistingText)} style={{borderWidth:1,padding:8}}/>
      <PublicMessageFile label="existing-device evidence" limit={limit} onRead={setExistingText} run={run} disabled={busy}/>
      <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(collectExisting)}><Text>Collect existing-device evidence</Text></Pressable>
      {expectedExisting.map(device=><Text key={device}>{device} · {existingEvidence[device]?'Verified':'Waiting for verification'}</Text>)}
     </>:null}
    </>:null}
    {files?<><Text>Encrypted files for household generation {files.generation}</Text>
     {files.recipients.map(({recipientDevice,joining})=><Pressable key={recipientDevice} accessibilityRole="button" disabled={busy} onPress={()=>void run(()=>savePublished(files.operationId,recipientDevice))}>
      <Text>{noun} encrypted file for {joining?'new':'existing'} device {recipientDevice}</Text>
     </Pressable>)}
    </>:null}
    <Text>To share an admission file again, you can also use its public invitation message.</Text>
    <TextInput accessibilityLabel="Previously prepared invitation message" multiline maxLength={limit} value={recoveryText} onChangeText={v=>bounded(v,setRecoveryText)} style={{borderWidth:1,padding:8}}/>
    <PublicMessageFile label="previous invitation" limit={limit} onRead={setRecoveryText} run={run} disabled={busy}/>
    <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(recoverFile)}><Text>{noun} an already admitted household file</Text></Pressable>
   </>:<>
    <Text>First verify the organizer’s latest public household authority above. Paste the invitation and enter the code you compared separately.</Text>
    <TextInput accessibilityLabel="Public invitation message input" multiline maxLength={limit} value={offerText} onChangeText={v=>bounded(v,setOfferText)} style={{borderWidth:1,padding:8}}/>
    <PublicMessageFile label="invitation" limit={limit} onRead={setOfferText} run={run} disabled={busy}/>
   </>}
   <TextInput accessibilityLabel="Confirmed invitation code" maxLength={128} value={code} onChangeText={setCode} placeholder="Code compared separately" style={{borderWidth:1,padding:8}}/>
   <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(begin)}><Text>Start or resume device verification</Text></Pressable>
   {phase?<><Text>{phase==='complete'?'Both devices have completed verification.':phase==='offer'?'Exchange your offer with the other device.':phase==='response'?'Exchange your response with the other device.':'Exchange your acknowledgement with the other device.'}</Text>
    <Text selectable accessibilityLabel="Your verification message">{output}</Text>
    <Pressable accessibilityRole="button" onPress={()=>void run(()=>copy(output))}><Text>Copy verification message</Text></Pressable>
    <PublicMessageFile label="verification message" limit={limit} outgoing={output} run={run} disabled={busy}/>
    {phase!=='complete'?<>
     <TextInput accessibilityLabel="Other device verification message" multiline maxLength={limit} value={peer} onChangeText={v=>bounded(v,setPeer)} style={{borderWidth:1,padding:8}}/>
     <PublicMessageFile label="verification message" limit={limit} onRead={setPeer} run={run} disabled={busy}/>
     <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(advance)}><Text>Continue device verification</Text></Pressable>
    </>:role==='organizer'?<Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(download)}>
     <Text>{expectedExisting.length?'Publish verified household generation':`Admit and ${noun.toLowerCase()} encrypted household file`}</Text>
    </Pressable>:<Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(install)}><Text>Choose encrypted household file</Text></Pressable>}
   </>:null}
   {published&&workspace.reopen?<>
    <Text>Reopen to edit cooking in the new generation. Edits saved to the previous generation are retained on this device.</Text>
    <Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(reopen)}><Text>Reopen household after admission</Text></Pressable>
   </>:null}
   {status?<Text accessibilityRole="alert">{status}</Text>:null}
  </>:null}
 </View>;
}
