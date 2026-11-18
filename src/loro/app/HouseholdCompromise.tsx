import {useContext,useEffect,useRef,useState} from 'react';
import {Platform,Pressable,Text,View} from 'react-native';
import {REPORT_FILE_LIMIT} from '../compromise/report-file.mjs';
import {chooseExchangeFile,saveExchangeFile} from './exchange-file';
import type {householdCompromise} from './household-compromise.mjs';
import {LoroWorkspaceValue} from './WorkspaceStatus';

type Reports = ReturnType<typeof householdCompromise>;
type Session = Awaited<ReturnType<Reports['open']>>;
type Draft = Awaited<ReturnType<Reports['prepare']>>;
type Review = Awaited<ReturnType<Reports['inspect']>>;
type Boundary = {kind:'checkpoint'} | {kind:'operation';ref:string};

const category = {
  suspect:'Authored by the reported device',
  dependent:'Depends on work by the reported device',
  other:'No such dependency found in this batch',
  uncertain:'Conflicting effect identity in this batch'
};

const errors:Record<string,string> = {
  INVALID_PROOF:'An encrypted original could not be authenticated.',
  INVALID_REPORT_SIGNATURE:'The report signature could not be verified.',
  MANIFEST_MISMATCH:'The original evidence does not match the signed report.',
  TOO_LARGE:'Evidence exceeds the review limit.',
  REPORT_CAPACITY:'This household has reached the saved report limit.',
  REPORT_AUTHORITY_CHANGED:'This report was frozen under earlier household authority. The saved evidence requires historical review.',
  REPORT_BRANCH_UNAVAILABLE:'The report belongs to a different household or policy branch.',
  CHECKPOINT_UNAVAILABLE:'This device could not verify the report’s checkpoint.',
  CHECKPOINT_MISMATCH:'This device could not verify the report’s checkpoint.',
  INVALID_CHECKPOINT:'The checkpoint could not be verified against these frozen originals.',
  CHECKPOINT_MISSING_ANCESTOR:'The frozen originals do not contain the history required to verify this checkpoint.',
  STALE_REPORT_SELECTION:'Household authority or selection changed. Reopen incident reports.',
  STALE_AUTHORITY:'Household authority changed. Reopen incident reports.',
  STALE_REVIEW:'The saved report changed. Reopen it before saving a clean draft.',
  STALE_DOCUMENT:'The cooking workspace changed. Reopen the report and review your selection again.',
  STALE_EVIDENCE:'Frozen evidence changed or became unavailable. Reopen the report.',
  POLICY_BASELINE_UNAVAILABLE:'The frozen originals could not verify a signed policy checkout boundary.',
  UNSUPPORTED_POLICY_LINEAGE:'An earlier policy change predates signed cooking checkout boundaries.',
  BOUNDARY_EVIDENCE_UNAVAILABLE:'The selected operation could not be verified inside this report’s cooking history.',
  UNSUPPORTED_SEED_BOUNDARY:'This report predates signed projection checkpoints for operation boundaries.',
  ORIGINAL_EVIDENCE_UNAVAILABLE:'Some frozen originals are unavailable.'
};

const heldReason:Record<string,string> = {
  DEPENDENCY_EXCLUDED:'A required operation was omitted.',
  MISSING_DEPENDENCY:'A required operation could not be replayed.',
  MISSING_ANCESTOR:'Signed predecessor evidence is unavailable.',
  OUTSIDE_POLICY_FRONTIER:'The operation falls outside the signed policy checkout boundary.',
  OUTSIDE_POLICY_LINEAGE:'The operation belongs to another policy branch.',
  CONFLICT:'The operation conflicts with another frozen original or a checkpoint identity.',
  MISSING_EVIDENCE:'The selected operation could not be authenticated.'
};

export function HouseholdCompromise() {
  const workspace = useContext(LoroWorkspaceValue);
  const service:Reports|undefined = workspace.householdCompromise;
  const lastService = useRef(service);
  lastService.current = service;
  const busyRef = useRef(false);
  const [session,setSession] = useState<Session|null>(null);
  const [devices,setDevices] = useState<string[]>([]);
  const [draft,setDraft] = useState<Draft|null>(null);
  const [boundary,setBoundary] = useState<Boundary|null>(null);
  const [review,setReview] = useState<Review|null>(null);
  const [retained,setRetained] = useState<string[]>([]);
  const [status,setStatus] = useState('');
  const [busy,setBusy] = useState(false);

  useEffect(()=>{
    setSession(null);
    setDevices([]);
    setDraft(null);
    setBoundary(null);
    setReview(null);
    setRetained([]);
    setStatus('');
  },[service]);

  if(!service)return null;
  const reports = service;
  const web = Platform.OS==='web';
  function viewReview(value:Review|null) {
    setReview(value);
    setRetained([]);
  }
  function run(task:(active:()=>boolean)=>Promise<void>) {
    if(busyRef.current)return;
    busyRef.current=true;
    setBusy(true);
    setStatus('');
    const active = () => lastService.current===reports;
    void task(active).catch(e=>{
      if(active())setStatus(errors[e?.message]??'The incident report could not be opened or saved.');
    }).finally(()=>{
      busyRef.current=false;
      setBusy(false);
    });
  }

  function close() {
    setSession(null);
    setDraft(null);
    setBoundary(null);
    viewReview(null);
    setStatus('');
  }
  async function open(active:()=>boolean) {
    const value = await reports.open();
    const targets = await reports.devices(value.confirmation);
    if(active()) { setSession(value); setDevices(targets); }
  }

  function show(confirmation:Session['confirmation'],id:string) {
    run(async active=>{
      const result=await reports.inspect(confirmation,id);
      if(active())viewReview(result);
    });
  }

  async function sign(active:()=>boolean) {
    if(!session||!draft||!boundary)return;
    const id = await reports.sign(draft,boundary);
    if(active()) {
      setDraft(null);
      setBoundary(null);
      setStatus('Signed report saved on this device.');
    }
    const next = await reports.open();
    const result = await reports.inspect(session.confirmation,id);
    if(active()) {setSession(next);viewReview(result);}
  }

  async function receive(active:()=>boolean) {
    if(!session)return;
    const accept = ['application/octet-stream','application/x-binary'];
    if(web)accept.push('.cc-report');
    const file = await chooseExchangeFile({accept,minBytes:5,maxBytes:REPORT_FILE_LIMIT});
    if(!file||!active())return;
    const {reviewId,replayed} = await reports.receive(session.confirmation,file);
    const next = await reports.open();
    const result = await reports.inspect(session.confirmation,reviewId);
    if(active()) {
      setSession(next);
      viewReview(result);
      setStatus(replayed?'This exact signed report was already saved.':'Signed report verified and available for review.');
    }
  }

  async function saveCleanDraft(active:()=>boolean) {
    if(!review)return;
    const saved = await reports.saveCleanDraft(review,retained);
    if(active()) {
      viewReview(saved);
      setStatus('Clean draft saved on this device.');
    }
  }

  return <View style={{gap:6}}>
    <Pressable accessibilityRole="button" disabled={busy} onPress={()=>session?close():run(open)}>
      <Text>{session?'Close household incident reports':'Open household incident reports'}</Text>
    </Pressable>
    {session&&<>
      <Text>Sign a judgment about a household device from a verified checkpoint or signed operation. Local quarantine has a separate confirmation.</Text>
      {devices.map(id=><Pressable key={id} accessibilityRole="button" disabled={busy} onPress={()=>run(async active=>{
        const prepared = await reports.prepare(session.confirmation,id);
        if(active()){setDraft(prepared);setBoundary(null);viewReview(null);}
      })}><Text>Prepare report for {id}</Text></Pressable>)}
      {!!draft&&<View style={{gap:6}}>
        <Text selectable>Report about {draft.suspectDevice}</Text>
        {draft.checkpoint||draft.operations.length
          ? <Text>Choose a boundary. This batch holds {draft.operations.length} signed operations.</Text>
          : <Text>No verified checkpoint or signed operation is available on this branch.</Text>}
        {draft.truncated&&<Text>The evidence limit was reached. Some retained originals are outside this batch.</Text>}
        {draft.checkpointOversized&&<Text>The verified checkpoint and this batch exceed the review limit.</Text>}
        {draft.excluded>0&&<Text>Originals outside this branch’s history or unavailable originals were omitted from the batch.</Text>}
        {!!draft.checkpoint&&<Pressable accessibilityRole="button" accessibilityState={{selected:boundary?.kind==='checkpoint'}} disabled={busy}
          onPress={()=>setBoundary({kind:'checkpoint'})}><Text>Use {draft.checkpoint.toLowerCase()}</Text></Pressable>}
        {draft.operations.map(op=><Pressable key={op.objectId} accessibilityRole="button" accessibilityState={{selected:boundary?.kind==='operation'&&boundary.ref===op.objectId}}
          disabled={busy} onPress={()=>setBoundary({kind:'operation',ref:op.objectId})}>
          <Text>Use signed {op.kind} operation {op.objectId}</Text>
          <Text selectable>Device {op.authorDevice}</Text>
        </Pressable>)}
        {boundary&&<Text selectable>{boundary.kind==='checkpoint'?draft.checkpoint:`Selected operation ${boundary.ref}`}</Text>}
        <Pressable accessibilityRole="button" disabled={busy||!boundary} onPress={()=>run(sign)}><Text>Sign and freeze incident report</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>{setDraft(null);setBoundary(null);}}><Text>Cancel report draft</Text></Pressable>
      </View>}
      <Pressable accessibilityRole="button" disabled={busy} onPress={()=>run(receive)}><Text>Choose signed incident report</Text></Pressable>
      {session.reports.map(record=><Pressable key={record.reviewId} accessibilityRole="button" disabled={busy}
        onPress={()=>show(session.confirmation,record.reviewId)}>
        <Text>Review incident report {record.reviewId}</Text>
      </Pressable>)}
      {review&&<View accessibilityLabel="Frozen incident evidence" style={{gap:6}}>
        <Text>Frozen evidence · {review.count} signed operations</Text>
        <Text selectable>Reporter device {review.reporterDevice}</Text>
        <Text selectable>Reported device {review.suspectDeviceIds.join(', ')}</Text>
        <Text selectable>{review.boundary.kind==='checkpoint'?(review.checkpointLabel??'Signed checkpoint'):`Selected operation ${review.boundary.ref}`}</Text>
        {review.checkpointUnavailable&&<Text>The frozen checkpoint is unavailable.</Text>}
        <Text>Evidence may be incomplete. Inherited operations must match each signed policy checkout boundary.</Text>
        {review.unsupported&&<Text>{review.legacyLineage ?
          'This older policy branch supports evidence inspection only.' : errors.UNSUPPORTED_SEED_BOUNDARY}</Text>}
        {review.canSave&&
          <Text>Choose operations to retain in a separate local draft. A verified projection checkpoint is carried forward as a whole.</Text>}
        {review.rows.map(row=><View key={row.objectId}>
          <Text>{category[row.category]}</Text>
          <Text selectable>{row.kind} · device {row.authorDevice} · operation {row.objectId}</Text>
          <Text selectable>Policy branch {row.sourceHead}</Text>
          {row.missingDependencies>0&&<Text>{row.missingDependencies} dependencies unavailable in this batch</Text>}
          {review.canSave&&row.selectable&&
            <Pressable accessibilityRole="checkbox" accessibilityLabel={`Retain operation ${row.objectId}`}
              accessibilityState={{checked:retained.includes(row.effectId)}} disabled={busy}
              onPress={()=>setRetained(ids=>ids.includes(row.effectId)?ids.filter(id=>id!==row.effectId):[...ids,row.effectId])}>
              <Text>{retained.includes(row.effectId)?'Selected to retain':'Retain in clean draft'}</Text>
            </Pressable>}
          {review.canSave&&!row.selectable&&<Text>This effect identity also appears elsewhere in the evidence.</Text>}
        </View>)}
        {review.missing.map((item:{objectId:string})=><Text key={item.objectId}>Frozen original unavailable · {item.objectId}</Text>)}
        {review.canSave&&
          <Pressable accessibilityRole="button" disabled={busy} onPress={()=>run(saveCleanDraft)}>
            <Text>Save clean draft with {retained.length} selected operations</Text>
          </Pressable>}
        {review.draft&&<View accessibilityLabel="Saved clean draft" style={{gap:6}}>
          <Text selectable>Local draft {review.draft.documentId}</Text>
          <Text>Included operations · {review.draft.included.length}</Text>
          {review.draft.included.map(row=><Text key={row.objectId} selectable>Included · {row.kind} · {row.objectId}</Text>)}
          <Text>Omitted operations · {review.draft.excluded.length}</Text>
          {review.draft.excluded.map(row=><Text key={row.objectId} selectable>Omitted · {row.objectId}</Text>)}
          <Text>Held operations · {review.draft.held.length}</Text>
          {review.draft.held.map((row,index)=><Text key={index} selectable>
            Held · {row.objectId??row.effectId} · {heldReason[row.reason??'']??'The operation could not be safely replayed.'}
          </Text>)}
          <Text>Pantry · {review.draft.pantry.join(', ')||'Empty'}</Text>
          <Text>Recipes · {review.draft.recipes.join(', ')||'Empty'}</Text>
          <Text>Shopping lists · {review.draft.shopping.join(', ')||'Empty'}</Text>
        </View>}
        {review.reporterDevice===workspace.deviceId&&<>
          <Text>The file contains device IDs and encrypted cooking evidence. Share it with the intended household member.</Text>
          <Pressable accessibilityRole="button" disabled={busy||review.checkpointUnavailable||review.missing.length>0} onPress={()=>run(async active=>{
          await reports.share(session.confirmation,review.reviewId,file=>saveExchangeFile('creative-cooking.cc-report','application/octet-stream',file));
          if(active())setStatus(web?'Signed report downloaded.':'Signed report handed to the share chooser.');
        })}><Text>{web?'Download signed incident report':'Share signed incident report'}</Text></Pressable>
        </>}
      </View>}
    </>}
    {!!status&&<Text accessibilityRole="alert">{status}</Text>}
  </View>;
}
