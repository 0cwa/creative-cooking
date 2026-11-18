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
  STALE_REPORT_SELECTION:'Household authority or selection changed. Reopen incident reports.',
  STALE_AUTHORITY:'Household authority changed. Reopen incident reports.',
  ORIGINAL_EVIDENCE_UNAVAILABLE:'Some frozen originals are unavailable.'
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
  const [status,setStatus] = useState('');
  const [busy,setBusy] = useState(false);

  useEffect(()=>{
    setSession(null);
    setDevices([]);
    setDraft(null);
    setBoundary(null);
    setReview(null);
    setStatus('');
  },[service]);

  if(!service)return null;
  const reports = service;
  const web = Platform.OS==='web';
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
    setReview(null);
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
      if(active())setReview(result);
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
    if(active()) {setSession(next);setReview(result);}
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
      setReview(result);
      setStatus(replayed?'This exact signed report was already saved.':'Signed report verified and available for review.');
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
        if(active()){setDraft(prepared);setBoundary(null);setReview(null);}
      })}><Text>Prepare report for {id}</Text></Pressable>)}
      {!!draft&&<View style={{gap:6}}>
        <Text selectable>Report about {draft.suspectDevice}</Text>
        {draft.checkpoint||draft.operations.length
          ? <Text>Choose a boundary. This batch holds {draft.operations.length} signed operations.</Text>
          : <Text>No verified checkpoint or signed operation is available on this branch.</Text>}
        {draft.truncated&&<Text>The evidence limit was reached. Some retained originals are outside this batch.</Text>}
        {draft.checkpointOversized&&<Text>The verified checkpoint and this batch exceed the review limit.</Text>}
        {draft.excluded>0&&<Text>Earlier policy branches or unavailable originals were omitted from the batch.</Text>}
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
        <Text>Evidence may be incomplete. This view checks signed dependencies within the selected policy branch. Dependencies across earlier policy branches remain unresolved.</Text>
        {review.rows.map(row=><View key={row.objectId}>
          <Text>{category[row.category]}</Text>
          <Text selectable>{row.kind} · device {row.authorDevice} · operation {row.objectId}</Text>
          {row.missingDependencies>0&&<Text>{row.missingDependencies} dependencies unavailable in this batch</Text>}
        </View>)}
        {review.missing.map((item:{objectId:string})=><Text key={item.objectId}>Frozen original unavailable · {item.objectId}</Text>)}
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
