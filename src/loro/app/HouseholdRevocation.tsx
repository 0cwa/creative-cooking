import {useContext,useRef,useState} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import {useAppState} from '@/state/AppState';
import {LoroWorkspaceValue} from './WorkspaceStatus';
import {chooseExchangeFile,saveExchangeFile} from './exchange-file';
import {PublicMessageFile} from './PublicMessageFile';
import {copyText} from './clipboard';
import type {householdRevocation} from './household-revocation.mjs';

type Service = ReturnType<typeof householdRevocation>;
type Status = Awaited<ReturnType<Service['status']>>;
type Reviewed = Awaited<ReturnType<Service['review']>> & {proposal:Parameters<Service['review']>[0]};
const publicLimit=512*1024;
const encoder=new TextEncoder();
const read=(value:string)=>{
  if(encoder.encode(value).length>publicLimit)throw Error('TOO_LARGE');
  return JSON.parse(value);
};
const errors:Record<string,string>={
  INVALID_DRAFT:'Choose a saved clean draft for an active device. Resolve held operations first.',
  RECIPIENT_BINDINGS_REQUIRED:'Collect a signed key binding from each remaining device.',
  INVALID_RECIPIENT:'A signed key binding is invalid, duplicated, or belongs to an excluded device.',
  STALE_AUTHORITY:'The proposal uses an earlier household authority. Review the current branch and prepare again.',
  SOURCE_CHANGED:'The report, draft, or source changed. Review the originals and save a fresh clean draft before preparing again.',
  INVALID_FILE:'This encrypted rotation file is unavailable for this device or does not match the reviewed decision.',
  INVALID_LATE_EVIDENCE:'This file is outside the selected branch’s verified revocation history.',
  CONFLICT:'The workspace changed or already holds different evidence. Reopen Settings and review the current branch.',
  CAPACITY:'The retained late-evidence limit has been reached.',
  IO:'Local storage could not complete the change. You can retry.'
};

export function HouseholdRevocation(){
  const workspace=useContext(LoroWorkspaceValue), app=useAppState();
  const service=workspace?.householdPairing?.revocation as Service|undefined;
  const [state,setState]=useState<Status|null>(null), [reviewed,setReviewed]=useState<Reviewed|null>(null);
  const [proposal,setProposal]=useState(''), [bindings,setBindings]=useState(''), [binding,setBinding]=useState('');
  const [status,setStatus]=useState(''), [busy,setBusy]=useState(false);
  const [needsStatus,setNeedsStatus]=useState(false);
  const reopen=state?.reopen??null;
  const paused=useRef<ReturnType<typeof app.beginWorkspaceTransition>|null>(null);
  const [late,setLate]=useState<string[]>([]), [inspection,setInspection]=useState<Awaited<ReturnType<Service['inspectLate']>>|null>(null);
  const [archive,setArchive]=useState<Awaited<ReturnType<Service['inspectBranch']>>|null>(null);
  const [archivedReport,setArchivedReport]=useState<Awaited<ReturnType<Service['inspectArchivedReport']>>|null>(null);
  const running=useRef(false);
  if(!service)return null;
  const controls=service;
  const author=workspace.deviceId;
  function run(action:()=>Promise<void>){
    if(running.current)return;
    running.current=true;
    setBusy(true);
    setStatus('');
    void action().catch(e=>setStatus(errors[e?.message]??(e instanceof Error?e.message:'Could not complete the household change.')))
      .finally(()=>{setBusy(false);running.current=false;});
  }
  const action=(label:string,fn:()=>Promise<void>,disabled=false)=>
    <Pressable accessibilityRole="button" disabled={disabled||busy} onPress={()=>run(fn)}><Text>{label}</Text></Pressable>;
  const copy=async(value:string)=>{if(!await copyText(value))throw Error('Copy the displayed message manually.');setStatus('Copied.');};
  function showStatus(current:Status){
    setState(current);
    setNeedsStatus(false);
    if(!current.reopen){
      paused.current?.();
      paused.current=null;
    }
  }
  async function refresh(){
    const current=await controls.status();
    showStatus(current);
    if(!current.reopen)setLate(await controls.lateEvidence());
  }
  function setReview(value:Reviewed){
    setReviewed(value);
    setProposal(JSON.stringify(value.proposal));
  }
  async function transition(commit:()=>Promise<{acceptedHead:string;replayed:boolean}>){
    const release=app.beginWorkspaceTransition();
    let keep=false;
    try{
      await app.flushCurrentWorkspace();
      const result=await commit();
      if(result.acceptedHead!==workspace.household.scope.branchHead){
        keep=true;
        paused.current=release;
        setNeedsStatus(true);
        // A competing transition can finish after a saved retry. Reopen only
        // the still-selected head returned by the status read.
        const current=await controls.status();
        showStatus(current);
        if(current.head!==result.acceptedHead)throw Error('STALE_AUTHORITY');
      }else{
        await refresh();
      }
      setStatus(result.replayed?'This exact rotation was already saved.':'Rotation saved on this device.');
    }finally{if(!keep)release();}
  }
  function loadProposal(value:string){setProposal(value);setReviewed(null);}
  if(needsStatus)return <View style={{gap:8}}>
    <Text>Rotation saved. Refresh the selected household branch to continue.</Text>
    {action('Refresh selected household branch',refresh)}
    {!!status&&<Text accessibilityRole="alert">{status}</Text>}
  </View>;
  return <View style={{gap:8}}>
    {!state?action('Manage device revocation',refresh):<>
      {!reopen&&action('Close device revocation',async()=>{setState(null);setReviewed(null);setProposal('');setBinding('');setBindings('');setInspection(null);setArchive(null);setArchivedReport(null);})}
      <Text selectable>Selected household branch {state.head}</Text>
      {state.devices.filter((device:{active:boolean})=>!device.active).map((device:{deviceId:string})=><Text key={device.deviceId} selectable>Revoked device {device.deviceId}</Text>)}
      <Text>Local quarantine applies on this device. A signed revocation creates a successor with a new key and clean cooking document. Each device chooses whether to open it.</Text>
      {reopen&&action('Reopen rotated household',async()=>{
        const result=await controls.status();
        showStatus(result);
        if(result.head!==reopen){
          if(!result.reopen)setLate(await controls.lateEvidence());
          setStatus('The selected household branch changed. Review the displayed branch before reopening.');
          return;
        }
        workspace.reopen({scopeId:workspace.household.scope.scopeId,head:reopen});
      })}
      {state.published&&<>
        <Text>Encrypted packages for generation {state.published.generation}</Text>
        {state.published.recipients.map((recipientDevice:string)=><View key={recipientDevice}>
          {action(`Download rotation for ${recipientDevice}`,async()=>{
            const bytes=await controls.seal({operationId:state.published!.operationId,recipientDevice});
            await saveExchangeFile(`creative-cooking-${recipientDevice}.cc-rotation`,'application/octet-stream',bytes);
          })}
        </View>)}
        {action('Show signed revocation decision',async()=>{
          const next=state.published!.proposal;
          setReview({proposal:next,...await controls.review(next,true,true)});
        })}
      </>}
      {state.branches.map(branch=><View key={branch.eventHash}>
        <Text selectable>{branch.selected?'Selected revocation':'Retained revocation · branch kept separate'} {branch.eventHash}</Text>
        {action('Review retained revocation',async()=>setReview({proposal:branch.proposal,...await controls.review(branch.proposal,true,true)}))}
      </View>)}
      {!reopen&&<>
        {action('Create signed recipient binding',async()=>setBinding(JSON.stringify(await controls.binding())))}
        {!!binding&&<>
          <Text selectable accessibilityLabel="Signed recipient binding">{binding}</Text>
          {action('Copy signed recipient binding',()=>copy(binding))}
          <PublicMessageFile label="recipient binding" limit={publicLimit} outgoing={binding} run={run} disabled={busy}/>
        </>}
        {!!state.drafts.length&&<>
          <Text>Paste the signed recipient bindings, one per line. The draft determines which device is excluded.</Text>
          <TextInput accessibilityLabel="Remaining device bindings" multiline editable={!busy} maxLength={publicLimit}
            value={bindings} onChangeText={setBindings} style={{borderWidth:1,padding:8}}/>
          <PublicMessageFile label="recipient binding" limit={publicLimit} onRead={value=>setBindings(previous=>[previous,value].filter(Boolean).join('\n'))} run={run} disabled={busy}/>
          {state.drafts.map(draft=><View key={draft.reviewId}>
            <Text selectable>Clean draft {draft.documentId} · Device {draft.deviceId}</Text>
            {action(`Prepare revocation from ${draft.reviewId}`,async()=>{
              setReviewed(null);
              setReview(await controls.prepare({reviewId:draft.reviewId,bindings:bindings.split('\n').filter(line=>line.trim()).map(read),explicit:true}));
            })}
          </View>)}
        </>}
      </>}
      <TextInput accessibilityLabel="Signed revocation message" multiline editable={!busy} maxLength={publicLimit}
        value={proposal} onChangeText={loadProposal} style={{borderWidth:1,padding:8}}/>
      <PublicMessageFile label="signed revocation" limit={publicLimit} onRead={loadProposal} run={run} disabled={busy}/>
      {!!proposal&&action('Review signed revocation',async()=>{setReviewed(null);const next=read(proposal);setReview({proposal:next,...await controls.review(next,true)});})}
      {!!reviewed&&<>
        <Text selectable>Device to revoke {reviewed.proposal.item.event.subject.deviceId}</Text>
        <Text selectable>Parent branch {reviewed.parentHead}</Text>
        <Text selectable>Incident report {reviewed.proposal.manifest.reviewId} · {reviewed.proposal.manifest.reportHash}</Text>
        <Text selectable>Clean document {reviewed.proposal.manifest.newDocumentId} · {reviewed.proposal.manifest.draftHash}</Text>
        <Text selectable>Remaining devices {reviewed.proposal.grant.recipients.join(', ')}</Text>
        <Text>{reviewed.approvals} of {reviewed.required} required adult approvals.</Text>
        {action('Copy signed revocation message',()=>copy(proposal))}
        <PublicMessageFile label="signed revocation" limit={publicLimit} outgoing={proposal} run={run} disabled={busy}/>
        {!reopen&&reviewed.canApprove&&reviewed.parentHead===state.head&&action('Sign approval for this revocation and draft',async()=>{
          setReview(await controls.approve({proposal:reviewed.proposal,confirmed:reviewed.confirmation,explicit:true}));
        })}
        {reviewed.complete&&<>
          {action('Keep my branch and retain this decision',async()=>{
            await controls.retain({proposal:reviewed.proposal,confirmed:reviewed.confirmation,explicit:true});
            await refresh();
            setStatus('Signed decision retained. This device kept its selected branch.');
          })}
          {!reopen&&reviewed.proposal.item.event.authorDeviceId===author&&reviewed.parentHead===state.head&&
            action('Confirm revocation and publish rotation',()=>transition(()=>controls.publish({proposal:reviewed.proposal,confirmed:reviewed.confirmation,explicit:true})))}
          {!reopen&&reviewed.proposal.item.event.authorDeviceId!==author&&reviewed.proposal.grant.recipients.includes(author)&&
            (reviewed.parentHead===state.head||reviewed.selected)&&action('Install reviewed encrypted rotation',async()=>{
              const bytes=await chooseExchangeFile({accept:['application/octet-stream','application/x-binary','.cc-rotation'],minBytes:48,maxBytes:16*1024*1024+48});
              if(bytes)await transition(()=>controls.install({bytes,proposal:reviewed.proposal,confirmed:reviewed.confirmation,explicit:true}));
            })}
        </>}
      </>}
      {!!state.archivedHeads.length&&<>
        <Text>Retained cooking branches</Text>
        {state.archivedHeads.map(head=><View key={head}>{action(`Review retained branch ${head}`,async()=>setArchive(await controls.inspectBranch(head)))}</View>)}
        {archive&&<View accessibilityLabel="Retained branch cooking">
          <Text selectable>Branch {archive.head}</Text>
          {archive.available?<>
            <Text>Pantry · {archive.pantry?.join(', ')||'Empty'}</Text>
            <Text>Recipes · {archive.recipes?.join(', ')||'Empty'}</Text>
            <Text>Shopping · {archive.shopping?.join(', ')||'Empty'}</Text>
          </>:<Text>This device has no retained cooking document for this branch.</Text>}
        </View>}
      </>}
      {state.archivedReports.map(report=><View key={report.reviewId}>
        {action(`Review archived incident ${report.reviewId}`,async()=>setArchivedReport(await controls.inspectArchivedReport(report.reviewId)))}
      </View>)}
      {archivedReport&&<View accessibilityLabel="Archived signed incident">
        <Text selectable>Original branch {archivedReport.head}</Text>
        <Text selectable>Reported device {archivedReport.deviceIds.join(', ')}</Text>
        <Text>{archivedReport.checkpointAvailable?'Original checkpoint verified.':'Original checkpoint unavailable.'}</Text>
        {archivedReport.objects.map((id:string)=><Text key={id} selectable>{archivedReport.missing.includes(id)?'Original unavailable':'Original retained'} · {id}</Text>)}
      </View>}
      {!reopen&&state.devices.some((device:{active:boolean})=>!device.active)&&<>
        {action('Hold late update for review',async()=>{
          const bytes=await chooseExchangeFile({accept:['application/octet-stream','application/x-binary'],minBytes:1,maxBytes:1024*1024});
          if(!bytes)return;
          await controls.holdLateEvidence(bytes);
          setLate(await controls.lateEvidence());
          setStatus('Signed old-branch evidence retained for review. Cooking was unchanged.');
        })}
        {late.map(id=><View key={id}>{action(`Review held update ${id}`,async()=>setInspection(await controls.inspectLate(id)))}</View>)}
        {inspection&&<>
          <Text selectable>Original branch {inspection.sourceHead}</Text>
          <Text selectable>Revoked author {inspection.authorDevice}</Text>
          <Text selectable>{inspection.command.kind} · {JSON.stringify(inspection.command.data)}</Text>
        </>}
      </>}
    </>}
    {!!status&&<Text accessibilityRole="alert">{status}</Text>}
  </View>;
}
