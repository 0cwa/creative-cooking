import {useEffect,useRef,useState} from 'react';
import {View} from 'react-native';
import {Pressable,Text} from '@/theme/primitives';
import type {householdCompromise} from './household-compromise.mjs';

type Service = ReturnType<typeof householdCompromise>;
type Session = Awaited<ReturnType<Service['selected']['open']>>;
type Plan = Awaited<ReturnType<Service['selected']['prepare']>>;
type Report = Awaited<ReturnType<Service['selected']['inspect']>>;
type Draft = Awaited<ReturnType<Service['selected']['reopenDraft']>>;

export function SelectedIncident({service}:{service:Service}) {
  const [session,setSession]=useState<Session|null>(null);
  const [devices,setDevices]=useState<string[]>([]);
  const [plan,setPlan]=useState<Plan|null>(null);
  const [boundary,setBoundary]=useState<Plan['operations'][number]|null>(null);
  const [report,setReport]=useState<Report|null>(null);
  const [draft,setDraft]=useState<Draft|null>(null);
  const [draftDevice,setDraftDevice]=useState('');
  const [selected,setSelected]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const [status,setStatus]=useState('');
  const [removal,setRemoval]=useState<{kind:'draft'|'report';id:string}|null>(null);
  const generation=useRef(0);
  const busyRef=useRef(false);
  useEffect(()=>()=>{generation.current++;},[service]);
  function run(task:(active:()=>boolean)=>Promise<void>) {
    if(busyRef.current)return;
    busyRef.current=true; setBusy(true); setStatus('');
    const current=generation.current;
    const active=()=>generation.current===current;
    void task(active).catch(e=>{
      if(active())setStatus(e?.message==='CAPACITY'
        ? 'This device has reached the saved report or draft limit. Delete an obsolete entry, then try again.'
        : e?.message==='REPORT_IN_USE_OR_AUTHORITY_CHANGED'
          ? 'The report could not be deleted. Delete drafts that use it first, or reopen this section if the household changed.'
          : ['STALE_SOURCE','DRAFT_SOURCE_CHANGED','STALE_DOCUMENT','STALE_EVIDENCE'].includes(e?.message)
            ? 'The source changed. Start a new report and choose the operations again.'
            : 'The report or draft could not be opened, saved or deleted. Reopen this section and try again.');
    }).finally(()=>{if(active()){busyRef.current=false;setBusy(false);}});
  }
  function close() {
    generation.current++; busyRef.current=false; setBusy(false); setSession(null); setDevices([]);
    setPlan(null); setBoundary(null); setReport(null); setDraft(null); setSelected([]); setStatus('');setRemoval(null);
  }
  function showReport(value:Report) {setReport(value);setPlan(null);setBoundary(null);setDraft(null);setSelected([]);}
  function removeControl(kind:'draft'|'report',id:string) {
    return <Pressable accessibilityRole="button" disabled={busy} onPress={()=>setRemoval({kind,id})}>
      <Text>Delete local {kind} {id}</Text>
    </Pressable>;
  }
  return <View style={{gap:6}}>
    <Pressable accessibilityRole="button" onPress={()=>session?close():run(async active=>{
      const next=await service.selected.open();
      const targets=await service.devices(next.confirmation);
      if(active()){setSession(next);setDevices(targets);}
    })}><Text>{session?'Close local report and draft':'Open local report and draft'}</Text></Pressable>
    {session&&<>
      <Text>Choose another device, then choose a verified signed operation as the boundary for a local report.</Text>
      {devices.map(id=><Pressable key={id} accessibilityRole="button" disabled={busy} onPress={()=>run(async active=>{
        const value=await service.selected.prepare(session.confirmation,id);
        if(active()){setPlan(value);setBoundary(null);setReport(null);setDraft(null);}
      })}><Text>Choose reported device {id}</Text></Pressable>)}
      {devices.length===0&&<Text>No other devices are available.</Text>}
      {plan&&<View style={{gap:6}}>
        <Text selectable>Selected reported device {plan.suspectDevice}</Text>
        {plan.excluded>0&&<Text>Some evidence was skipped because it was unavailable or could not be verified ({plan.excluded} operations).</Text>}
        {plan.truncated&&<Text>The evidence limit was reached; some operations were not included.</Text>}
        {plan.operations.length===0&&<Text>No verified signed operations are available.</Text>}
        {plan.operations.map(op=><Pressable key={`${op.documentId}:${op.objectId}`} accessibilityRole="radio"
          accessibilityState={{checked:boundary?.documentId===op.documentId&&boundary.objectId===op.objectId}} disabled={busy}
          onPress={()=>setBoundary(op)}><Text>Choose boundary: {op.kind} · device {op.authorDevice} · operation {op.objectId}</Text></Pressable>)}
        <Pressable accessibilityRole="button" disabled={busy||!boundary} onPress={()=>run(async active=>{
          if(!boundary)return;
          const {reportHash}=await service.selected.sign(plan,{suspectDevice:plan.suspectDevice,documentId:boundary.documentId,objectId:boundary.objectId});
          const next=await service.selected.open();
          const value=await service.selected.inspect(next.confirmation,reportHash);
          if(active()){setSession(next);showReport(value);setStatus('Signed report frozen on this device.');}
        })}><Text>Sign and freeze local report</Text></Pressable>
      </View>}
      {session.reportHashes.map(id=><View key={id}><Pressable accessibilityRole="button" disabled={busy} onPress={()=>run(async active=>{
        const value=await service.selected.inspect(session.confirmation,id); if(active())showReport(value);
      })}><Text>Open local report {id}</Text></Pressable>{removeControl('report',id)}</View>)}
      {session.draftIds.map(id=><View key={id}><Pressable accessibilityRole="button" disabled={busy} onPress={()=>run(async active=>{
        const value=await service.selected.reopenDraft(session.confirmation,id);
        const source=await service.selected.inspect(session.confirmation,value.reportHash);
        if(active()){setDraft(value);setDraftDevice(source.suspectDevice);setReport(null);setPlan(null);}
      })}><Text>Open local draft {id}</Text></Pressable>{removeControl('draft',id)}</View>)}
      {removal&&<View style={{gap:6}}>
        <Text selectable>Delete the saved local {removal.kind} {removal.id}?</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>setRemoval(null)}><Text>Cancel deletion</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>run(async active=>{
          const {kind,id}=removal;
          const next=await service.selected.deleteSaved(session.confirmation,kind,id,true);
          if(active()){
            setSession(next);setRemoval(null);
            if(kind==='draft'&&draft?.draftId===id)setDraft(null);
            if(kind==='report'&&report?.reportHash===id){setReport(null);setSelected([]);}
            setStatus(kind==='draft'?'Local draft deleted.':'Local report and its frozen evidence deleted.');
          }
        })}><Text>Confirm delete local {removal.kind}</Text></Pressable>
      </View>}
      {report&&<View style={{gap:6}}>
        <Text selectable>Reported device {report.suspectDevice}</Text>
        <Text selectable>Signed boundary operation {report.boundary.objectId}</Text>
        <Text>Choose effects to carry forward into a separate local draft.</Text>
        {report.operations.map(op=><Pressable key={`${op.documentId}:${op.objectId}`} accessibilityRole="checkbox"
          accessibilityLabel={`Carry forward ${op.kind} operation ${op.objectId}`} accessibilityState={{checked:selected.includes(op.effectId)}} disabled={busy}
          onPress={()=>setSelected(ids=>ids.includes(op.effectId)?ids.filter(id=>id!==op.effectId):[...ids,op.effectId])}>
          <Text>{selected.includes(op.effectId)?'Selected':'Select'} · {op.kind} · device {op.authorDevice} · operation {op.objectId}</Text>
        </Pressable>)}
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>run(async active=>{
          const {draftId}=await service.selected.saveDraft(session.confirmation,report.reportHash,selected);
          const next=await service.selected.open();
          const value=await service.selected.reopenDraft(next.confirmation,draftId);
          if(active()){setSession(next);setDraft(value);setDraftDevice(report.suspectDevice);setStatus('Local draft saved.');}
        })}><Text>Save local draft</Text></Pressable>
      </View>}
      {draft&&<View accessibilityLabel="Local draft preview" style={{gap:6}}>
        <Text selectable>Local draft {draft.draftId}</Text>
        <Text selectable>Reported device {draftDevice}</Text>
        {(['retained','excluded','held'] as const).map(state=><View key={state}>
          <Text>{state==='retained'?'Retained operations':state==='excluded'?'Excluded operations':'Held operations'}</Text>
          {draft.rows.filter(row=>row.status===state).map(row=><Text key={`${row.documentId}:${row.objectId}`} selectable>
            {row.objectId} · {row.authorship==='suspect'?'reported device':'another device'}{state==='held'?' · Could not be safely carried forward.':''}
          </Text>)}
          {!draft.rows.some(row=>row.status===state)&&<Text>None</Text>}
        </View>)}
        <Text>Pantry · {draft.pantry.join(', ')||'Empty'}</Text>
        <Text>Recipes · {draft.recipes.join(', ')||'Empty'}</Text>
        <Text>Shopping · {draft.shopping.join(', ')||'Empty'}</Text>
      </View>}
    </>}
    {!!status&&<Text accessibilityRole="alert">{status}</Text>}
  </View>;
}
