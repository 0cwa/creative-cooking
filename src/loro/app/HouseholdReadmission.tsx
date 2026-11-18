import {useContext,useRef,useState} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import {useAppState} from '@/state/AppState';
import {LoroWorkspaceValue} from './WorkspaceStatus';
import {PersonalRecoveryPanel} from './PersonalRecoveryPanel';
import {GuardianStart} from './guardians/GuardianStart';
import {PublicMessageFile} from './PublicMessageFile';
import {readRecoveryArchiveFile} from './recovery-input.mjs';
import {ArchiveFile} from './ArchiveFile';
import {chooseExchangeFile,saveExchangeFile} from './exchange-file';

const limit=512*1024;
const sponsorLimit=1024*1024;
const encoder=new TextEncoder();
function parse(text:string,maxBytes=limit){
 if(encoder.encode(text).length>=maxBytes)throw Error('MESSAGE_TOO_LARGE');
 return JSON.parse(text);
}
const explanations:Record<string,string>={
 CONTINUITY_NOT_REGISTERED:'This device has no retained registration for that adult. Personal recovery is still available.',
 WRONG_RECOVERY_GENERATION:'The archive does not follow this household’s registered generation. Use the matching archive.',
 INVALID_CONTEXT:'The request does not match the current head, registered generation or continuity key. Recovered personal data is still available.',
 INELIGIBLE_RECOVERY:'Readmission requires the adult to remain on this branch with all their previous devices retired. Personal recovery is still available.',
 NO_AUTHORIZED_QUORUM:'Too few eligible current adults can authorize readmission under this branch’s rule. Recovered personal data is still available.',
 CONFIRMATION_REQUIRED:'Independently verify the current household root and head using Show device identity before requesting access.',
 MISSING_REQUEST:'Create a recovery request from the imported archive first.',
 MISSING_SPONSOR_PARENT:'Ask the adult who will sponsor your readmission for their signed parent export.',
 INVALID_SPONSOR:'Use the signed parent export from the sponsoring device. Ask that adult for a new export if their branch history changed.',
 MISSING_CHALLENGE:'The issuing device has no matching saved challenge.',
 STALE_AUTHORITY:'This message uses a different household head. Compare the current root and head with an eligible adult.',
 WRONG_RECOVERY_OWNER:'The archive must authenticate this device’s personal authority and its household adult.',
 APPROVAL_UNAVAILABLE:'Only a current eligible adult can approve the reviewed decision once.',
 INVALID_FILE:'This encrypted file could not be opened. Check the reviewed decision and recipient.',
 SOURCE_CHANGED:'Cooking changed after review. Prepare a new decision from the current saved data.',
};
type Decision={proposal:any;confirmation?:string;canApprove?:boolean;complete:boolean;approvals:number;required:number;eventHash:string;grantHash:string};
type BranchStatus={head:string;reopen:string|null;published:null|{operationId:string;recipients:string[];proposal:any}};

export function HouseholdReadmission(){
 const workspace=useContext(LoroWorkspaceValue),app=useAppState(),service=workspace?.householdPairing?.readmission;
 const [mode,setMode]=useState<'setup'|'member'|'fresh'|null>(null);
 const [status,setStatus]=useState(''),[busy,setBusy]=useState(false);
 const [incoming,setIncoming]=useState(''),[outgoing,setOutgoing]=useState(''),[householdId,setHouseholdId]=useState('');
 const [sponsorText,setSponsorText]=useState('');
 const [bindings,setBindings]=useState(''),[code,setCode]=useState(''),[archive,setArchive]=useState<File|null>(null);
 const [decision,setDecision]=useState<Decision|null>(null),[recipient,setRecipient]=useState(false);
 const [branch,setBranch]=useState<BranchStatus|null>(null),[refreshNeeded,setRefreshNeeded]=useState(false);
 const [installed,setInstalled]=useState<{scope:{id:string};acceptedHead:string}[]>([]),[archiveRevision,setArchiveRevision]=useState(0);
 const running=useRef(false), paused=useRef<(()=>void)|null>(null);
 if(!service)return null;
 const fresh=mode==='fresh';
 function run(use:()=>Promise<void>){
  if(running.current)return;
  running.current=true;setBusy(true);setStatus('');
  void use().catch(error=>{
   const message=error instanceof Error?error.message:'';
   setStatus(explanations[message]??(message||'The recovery step could not be completed.'));
  }).finally(()=>{running.current=false;setBusy(false);});
 }
 const button=(label:string,use:()=>Promise<void>,disabled=false)=><Pressable accessibilityRole="button"
  disabled={busy||disabled} onPress={()=>run(use)}><Text>{label}</Text></Pressable>;
 function input(text:string){setIncoming(text);setDecision(null);setRecipient(false);setOutgoing('');}
 function show(value:unknown){
  const text=JSON.stringify(value);
  if(encoder.encode(text).length>=limit)throw Error('MESSAGE_TOO_LARGE');
  setOutgoing(text);
 }
 function switchMode(next:typeof mode){
  setMode(next);input('');setSponsorText('');setOutgoing('');setStatus('');setBranch(null);
 }
 function reviewed(value:Decision){setDecision(value);setRecipient(false);show(value.proposal);}
 async function refresh(){
  const active=await service.status();
  setBranch(active);setRefreshNeeded(false);
  if(!active.reopen){paused.current?.();paused.current=null;}
  return active as BranchStatus;
 }
 async function transition(commit:()=>Promise<{acceptedHead:string;replayed:boolean}>){
  const release=app.beginWorkspaceTransition();
  let keep=false;
  try{
   await app.flushCurrentWorkspace();
   const saved=await commit();
   if(saved.acceptedHead!==workspace.household.scope.branchHead){
    keep=true;paused.current=release;setRefreshNeeded(true);
    const active=await refresh();
    if(active.head!==saved.acceptedHead)throw Error('STALE_AUTHORITY');
   }
   setStatus(saved.replayed?'This exact household rotation is already saved.':'Household rotation saved. Reopen to edit on the new branch.');
  }finally{if(!keep)release();}
 }
 const pickFile=()=>chooseExchangeFile({accept:['.cc-recovery'],minBytes:48,maxBytes:16*1024*1024+48});
 return <View style={{gap:8}}>
  {!mode?<>{button('Set up household recovery continuity',async()=>switchMode('setup'))}
    {button('Authorize household readmission',async()=>{switchMode('member');await refresh();})}
    {button('Recover personal data and request readmission',async()=>{switchMode('fresh');setInstalled(await service.installed());})}</>:
    !branch?.reopen&&!refreshNeeded&&button('Close recovery continuity',async()=>switchMode(null))}
  {mode==='setup'&&<>
   <Text accessibilityRole="header">Optional household recovery continuity</Text>
   <Text>Make a personal archive, then register that exact archive on the current household branch. Send the public registration to eligible adults so they can compare the generation later. You can also register an archive created with guardian recovery. Keep the encrypted archive and code separately. A newer registration replaces the continuity credential, while the archive still contains the existing personal data key.</Text>
   <PersonalRecoveryPanel create={()=>service.createArchive()} createLabel="Create archive for continuity registration"/>
   <TextInput accessibilityLabel="Code for continuity registration" value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} editable={!busy}/>
   <ArchiveFile download={null} disabled={busy} onFile={setArchive}/>
   {button('Register this personal archive',async()=>{
    if(!archive)throw Error('Choose the archive first.');
    show(await service.registerArchive({archive:await readRecoveryArchiveFile(archive),code,explicit:true}));
    setStatus('Continuity registered locally. Ask current adults to retain this signed generation while this branch is current.');
   },!archive||!code)}
  </>}
  {fresh&&<>
   <Text accessibilityRole="header">Restore personal data on this device</Text>
   <Text>The recovered archive opens privately here. Household readmission requires a separate verified request and authorization from eligible current adults. If no eligible adults survive, you can still read the available personal copy here.</Text>
   <PersonalRecoveryPanel key={archiveRevision} read={workspace.recoveryImport.read} restore={workspace.recoveryImport.restore}/>
   <GuardianStart restoreIntoWorkspace={async(...args)=>{
    const result=await workspace.recoveryImport.restore(...args);setArchiveRevision(n=>n+1);return result;
   }}/>
   <Text>Use Show device identity to verify the household root and head with your sponsoring adult. Provide that device’s signed readmission parent export before making a request.</Text>
   <TextInput accessibilityLabel="Verified household ID" value={householdId} onChangeText={text=>{setHouseholdId(text);setDecision(null);setRecipient(false);setOutgoing('')}} maxLength={256} editable={!busy}/>
   <TextInput accessibilityLabel="Sponsoring device parent proof" value={sponsorText} onChangeText={setSponsorText}
    multiline maxLength={sponsorLimit} editable={!busy}/>
   <PublicMessageFile label="signed readmission parent" limit={sponsorLimit} onRead={setSponsorText} run={run} disabled={busy}/>
   {button('Create signed recovery request',async()=>{
    setOutgoing('');show(await service.request({householdId,sponsorParent:sponsorText?parse(sponsorText,sponsorLimit):undefined,explicit:true}));setStatus('Send this signed request to the sponsoring adult.');
   },!householdId)}
   {button('Answer recovery challenge',async()=>{
    setOutgoing('');show(await service.answer({householdId,message:parse(incoming),explicit:true}));setStatus('Send this proof of the new device’s keys to the adult who issued the challenge.');
   },!householdId||!incoming)}
  </>}
  {mode==='member'&&<>
   <Text accessibilityRole="header">Authorize current household readmission</Text>
   <Text>Keep the registered generation on every approving device. The household must revoke the adult’s previous devices first. Review the fresh device and exact recipient set with the current adults before authorizing release of current cooking data.</Text>
   {refreshNeeded&&button('Refresh readmission branch',async()=>{await refresh();})}
   {branch?.reopen&&button('Reopen household after readmission',async()=>{
    const target=branch.reopen,active=await refresh();
    if(active.reopen!==target)throw Error('STALE_AUTHORITY');
    workspace.reopen({scopeId:workspace.household.scope.scopeId,head:target});
   })}
   {branch?.published&&<>
    {button('Show published readmission decision',async()=>show(branch.published!.proposal))}
    {branch.published.recipients.map(id=><View key={id}>{button(`Download readmission for ${id}`,async()=>{
     const bytes=await service.seal({operationId:branch.published!.operationId,recipientDevice:id});
     await saveExchangeFile(`creative-cooking-${id}.cc-recovery`,'application/octet-stream',bytes);
    })}</View>)}
   </>}
   {!branch?.reopen&&!refreshNeeded&&<>
    {button('Show signed readmission parent',async()=>{
     const text=JSON.stringify(await service.exportSponsorParent());
     if(encoder.encode(text).length>=sponsorLimit)throw Error('MESSAGE_TOO_LARGE');
     setSponsorText(text);
    })}
    {sponsorText&&<>
     <Text selectable accessibilityLabel="Signed readmission parent">{sponsorText}</Text>
     <PublicMessageFile label="signed readmission parent" limit={sponsorLimit} outgoing={sponsorText} run={run} disabled={busy}/>
    </>}
    {button('Retain signed continuity registration',async()=>{
     const result=await service.retainRegistration({message:parse(incoming),explicit:true});
     setStatus(result.replayed?'This exact continuity generation is already retained.':'Signed continuity generation retained on this device.');
    },!incoming)}
    {button('Issue recovery challenge',async()=>{
     setOutgoing('');show(await service.issue({request:parse(incoming),explicit:true}));setStatus('Send the sealed challenge to the fresh device.');
    },!incoming)}
    {button('Show readmission recipient binding',async()=>show(await service.binding()))}
    <TextInput accessibilityLabel="Other current device bindings" placeholder="Paste one signed binding per line" value={bindings} onChangeText={setBindings}
      multiline maxLength={limit} editable={!busy}/>
    {button('Prepare readmission decision',async()=>{
     setDecision(null);await app.flushCurrentWorkspace();
     reviewed(await service.prepare({response:parse(incoming),bindings:bindings.split('\n').filter(line=>line.trim()).map(line=>parse(line)),explicit:true}));
    },!incoming)}
    {button('Review readmission for approval',async()=>{
     setDecision(null);const proposal=parse(incoming);reviewed({proposal,...await service.review(proposal)});
    },!incoming)}
    {decision&&!recipient&&button('Approve this readmission',async()=>reviewed(await service.approve({
     proposal:decision.proposal,confirmed:decision.confirmation,explicit:true
    })),!decision.canApprove)}
    {decision&&!recipient&&button('Publish readmission and rotate household key',()=>transition(()=>service.publish({
     proposal:decision.proposal,confirmed:decision.confirmation,explicit:true
    })),!decision.complete)}
   </>}
  </>}
  {(fresh||mode==='member'&&!branch?.reopen&&!refreshNeeded)&&<>
   <TextInput accessibilityLabel="Incoming recovery message" value={incoming} onChangeText={input} multiline maxLength={limit} editable={!busy}/>
   <PublicMessageFile label="recovery message" limit={limit} onRead={input} run={run} disabled={busy}/>
   {button('Review household access file decision',async()=>{
    setDecision(null);setRecipient(false);
    const proposal=parse(incoming),verified=await service.reviewRecipient({proposal,fresh});
    setDecision({proposal,...verified});setRecipient(true);
   },!incoming)}
   {decision&&recipient&&button('Install verified readmission file',async()=>{
    const bytes=await pickFile();if(!bytes)return;
    const install=()=>service.install({proposal:decision.proposal,bytes,fresh,explicit:true});
    if(!fresh){await transition(install);return;}
    const result=await install();
    setInstalled(await service.installed());
    setStatus(result.replayed?'This exact readmission is already installed.':'Household installed on this device. Open it explicitly to start using it.');
   })}
  </>}
  {decision&&<View>
   <Text selectable>{`Fresh device ${decision.proposal.item.event.subject.deviceId} · Recovered adult ${decision.proposal.item.event.subject.owner}`}</Text>
   <Text selectable>{`Parent ${decision.proposal.item.event.parentHead} · Recovery generation ${decision.proposal.item.event.subject.bindingGeneration}`}</Text>
   <Text selectable>{`Decision ${decision.eventHash} · Grant ${decision.grantHash}`}</Text>
   <Text selectable>{`Source revision ${decision.proposal.manifest.sourceRevision??'empty'} · Source hash ${decision.proposal.manifest.sourceHash}`}</Text>
   <Text selectable>{`Recipients ${decision.proposal.grant.recipients.join(', ')}. ${decision.approvals} of ${decision.required} required adults.`}</Text>
  </View>}
  {fresh&&installed.filter(entry=>entry.scope.id!==workspace.household.scope.scopeId).map(entry=><View key={entry.scope.id}>
   <Text selectable>Installed household {entry.scope.id}</Text>
   {button('Open readmitted household',async()=>{
    const release=app.beginWorkspaceTransition();
    try{
     await app.flushCurrentWorkspace();
     await workspace.householdPairing.selection.select(entry.scope,entry.acceptedHead);
     workspace.reopen({scopeId:entry.scope.id,head:entry.acceptedHead});
    }catch(error){release();throw error;}
   })}
  </View>)}
  {outgoing&&<>
   <Text selectable accessibilityLabel="Outgoing recovery message">{outgoing}</Text>
   <PublicMessageFile label="outgoing recovery message" limit={limit} outgoing={outgoing} run={run} disabled={busy}/>
  </>}
  {status&&<Text accessibilityRole="alert">{status}</Text>}
 </View>;
}
