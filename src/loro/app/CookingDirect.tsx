import {useContext, useEffect, useRef, useState} from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {useAppState} from '@/state/AppState';
import {MAX_SIGNAL} from '../transport/direct-signal.mjs';
import {copyText} from './clipboard';
import {LoroWorkspaceValue} from './WorkspaceStatus';

type Status = {
  ready:boolean; closed:boolean; error:string|null;
  receivedApplied:number; receivedRetained:number; peerStored:number; peerApplied:number;
};
const initial:Status = {ready:false, closed:false, error:null, receivedApplied:0, receivedRetained:0, peerStored:0, peerApplied:0};
const messages:Record<string,string> = {
  INVALID_SIGNAL:'This connection message is invalid.',
  INVALID_SIGNAL_SIGNATURE:'The connection message signature is invalid.',
  SIGNAL_TOO_LARGE:'This connection message is too large.',
  DIRECT_HOUSEHOLD_MISMATCH:'The connection message is for a different household, device or invitation.',
  UNAUTHORIZED_PEER:'This device is no longer authorized for direct exchange in the open household.',
  INVALID_AUTHORITY:'The household authority changed. Reopen the household to continue.',
  HOUSEHOLD_SELECTION_CHANGED:'The open household changed. Reopen the app to continue.',
  NEGOTIATED_SIGNAL_MISMATCH:'The connection did not match the signed messages.',
  DIRECT_CODE_MISMATCH:'The verification code does not match this connection.',
  INVALID_CONFIRMATION:'The other device’s confirmation could not be verified.',
  DIRECT_CONNECTION_FAILED:'The devices could not connect directly. Try another network or exchange encrypted cooking files.',
  ICE_GATHERING_TIMEOUT:'The browser could not prepare a direct connection. You can exchange encrypted cooking files.',
  DIRECT_CLOSED:'The other device disconnected.',
  DIRECT_TIMEOUT:'The connection expired. Start a new direct connection to continue.',
  DIRECT_RESULT_TIMEOUT:'The other device did not confirm the update in time. Reconnect to retry.',
  DIRECT_LIMIT:'This connection reached its exchange limit. Reconnect to continue.'
};

function button(label:string, action:()=>void, disabled=false) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={action} style={[styles.button, disabled&&styles.disabled]}><Text>{label}</Text></Pressable>;
}

export function CookingDirect() {
  const workspace = useContext(LoroWorkspaceValue);
  const app = useAppState();
  const latestApp = useRef(app);
  latestApp.current = app;
  const active = useRef<any>(null);
  const [open, setOpen] = useState(false);
  const [peer, setPeer] = useState('');
  const [role, setRole] = useState<'offer'|'answer'>('offer');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [code, setCode] = useState('');
  const [entered, setEntered] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(initial);
  const [notice, setNotice] = useState('');
  const peers:string[] = workspace.direct?.peers ?? [];

  useEffect(() => () => {
    const session = active.current;
    active.current = null;
    session?.close();
  }, [workspace]);

  function reset() {
    const session = active.current;
    active.current = null;
    session?.close();
    setInput('');
    setOutput('');
    setCode('');
    setEntered('');
    setConfirmed(false);
    setNotice('');
    setStatus(initial);
  }
  function run(fn:()=>Promise<void>) {
    setNotice('');
    setBusy(true);
    void fn().catch(error => setNotice(messages[error?.message] ?? 'This direct exchange step could not finish. You can try again or use encrypted cooking files.'))
      .finally(() => setBusy(false));
  }
  function newSession() {
    const session = workspace.direct.connect({notify:(next:Status)=>{
      if (active.current === session) setStatus(next);
    }, importUpdate:async (item:{itemId:string; bytes:Uint8Array}, authorize:()=>Promise<void>)=>{
      const current = latestApp.current;
      const release = current.beginWorkspaceTransition();
      try {
        await current.flushCurrentWorkspace();
        await authorize();
        const result = await workspace.cookingFiles.applyStaged(item);
        if (result.status !== 'pending') {
          try {
            await current.refreshSharedCooking?.();
          } catch {
            // The workspace exposes the refresh error. Import already committed.
          }
        }
        return result;
      } finally { release(); }
    }});
    active.current = session;
    return session;
  }
  async function start() {
    const session = newSession();
    try {
      if (role === 'offer') setOutput(await session.createOffer(peer || peers[0]));
      else {
        const answer = await session.createAnswer(input);
        setOutput(answer.text);
        setCode(answer.code);
        setInput('');
      }
    } catch (error) {
      active.current = null;
      session.close();
      throw error;
    }
  }
  async function readSignalFile() {
    const inputElement = document.createElement('input');
    inputElement.type = 'file';
    inputElement.accept = '.json,application/json';
    const file = await new Promise<File>((resolve, reject) => {
      inputElement.onchange = () => inputElement.files?.[0] ? resolve(inputElement.files[0]) : reject(Error('INVALID_SIGNAL'));
      inputElement.oncancel = () => reject(Error('INVALID_SIGNAL'));
      inputElement.click();
    });
    if (file.size > MAX_SIGNAL) throw Error('SIGNAL_TOO_LARGE');
    setInput(await file.text());
  }
  function saveSignalFile() {
    const url = URL.createObjectURL(new Blob([output], {type:'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = `creative-cooking-direct-${role}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function sendUpdates() {
    await latestApp.current.flushCurrentWorkspace();
    const result = await active.current.send();
    const text = !result.sent ? 'No local updates are waiting for this device.' : result.retry
      ? `${result.retry} update${result.retry === 1 ? '' : 's'} still waiting for the other device to apply. You can retry this batch.`
      : result.more ? 'This batch was applied. Send cooking updates again to continue.' : 'The other device applied this batch.';
    setNotice(text);
  }
  async function retryRefresh() {
    await workspace.direct.withSelected(async () => {
      const current = latestApp.current;
      const release = current.beginWorkspaceTransition();
      try {
        await current.flushCurrentWorkspace();
        await current.refreshSharedCooking?.();
      } finally { release(); }
    });
  }

  if (!workspace.direct || typeof RTCPeerConnection !== 'function') return null;
  const responseInput = (role === 'answer' && !output) || (role === 'offer' && output && !code);
  return <View style={styles.group}>
    {button(open ? 'Close direct cooking exchange' : 'Exchange cooking updates directly', () => {if (open) reset(); setOpen(!open);}, busy)}
    {open && <>
      {!peers.length && <Text>Invite a device to this household before starting direct exchange.</Text>}
      {!!peers.length && !status.closed && <>
        <Text>Keep both devices on this screen. Before confirming, compare the verification codes aloud or over a separate trusted channel.</Text>
        {!output && <View style={styles.actions}>
          {button('Start a connection', () => {setRole('offer'); setInput('');}, busy || role === 'offer')}
          {button('Answer a connection', () => {setRole('answer'); setInput('');}, busy || role === 'answer')}
        </View>}
        {!output && role === 'offer' && peers.length > 1 && <>
          <Text>Choose the other device. Its device ID is in the public device identity.</Text>
          {peers.map(id => <Pressable key={id} accessibilityRole="radio" accessibilityState={{checked:(peer||peers[0])===id}} onPress={() => setPeer(id)} disabled={busy} style={styles.button}><Text>{id}</Text></Pressable>)}
        </>}
        {responseInput && <>
          <TextInput accessibilityLabel={role === 'offer' ? 'Direct connection answer' : 'Direct connection offer'} value={input} onChangeText={setInput} multiline maxLength={MAX_SIGNAL} editable={!busy} style={styles.input} />
          {button('Choose connection message file', () => run(readSignalFile), busy)}
        </>}
        {!output && button(role === 'offer' ? 'Create connection offer' : 'Verify offer and create answer', () => run(start), busy || (role === 'answer' && !input.trim()))}
        {output && !confirmed && <>
          <Text>{role === 'offer' ? 'Share this offer with the other device.' : 'Share this answer with the other device.'}</Text>
          <Text selectable accessibilityLabel="Outgoing direct connection message" style={styles.signal}>{output}</Text>
          <View style={styles.actions}>
            {button('Copy connection message', () => run(async () => {if (!await copyText(output)) setNotice('Copy the displayed connection message or download its file.');}), busy)}
            {button('Download connection message', saveSignalFile, busy)}
          </View>
        </>}
        {role === 'offer' && output && !code && button('Verify connection answer', () => run(async () => {setCode(await active.current.acceptAnswer(input)); setInput('');}), busy || !input.trim())}
        {code && !confirmed && <>
          <Text selectable accessibilityLabel="Direct verification code">{code}</Text>
          <TextInput accessibilityLabel="Independently compared direct verification code" value={entered} onChangeText={setEntered} autoCapitalize="characters" autoCorrect={false} maxLength={48} editable={!busy} style={styles.input} />
          {button('Confirm compared code', () => run(async () => {await active.current.confirm(entered); setConfirmed(true);}), busy || !entered.trim())}
        </>}
        {confirmed && !status.ready && <Text accessibilityLiveRegion="polite">Waiting for the other device to confirm and connect.</Text>}
        {status.ready && <>
          <Text accessibilityLiveRegion="polite">Direct connection verified on both devices.</Text>
          {button('Send cooking updates', () => run(sendUpdates), busy)}
        </>}
      </>}
      {(status.ready || status.closed) && (status.peerStored + status.receivedApplied + status.receivedRetained > 0) && <View accessibilityLiveRegion="polite">
        <Text>Peer receipts for this connection: {status.peerStored} stored, {status.peerApplied} applied.</Text>
        <Text>Received here: {status.receivedApplied} applied, {status.receivedRetained} retained without applying.</Text>
      </View>}
      {(output || status.closed) && button(status.closed ? 'Start over' : 'Disconnect direct exchange', reset, busy)}
      {status.error && <Text accessibilityRole="alert">{messages[status.error] ?? 'The direct connection closed. Reconnect to retry or exchange encrypted cooking files.'}</Text>}
      {!!notice && <Text accessibilityLiveRegion="polite">{notice}</Text>}
    </>}
    {app.sharedCookingRefreshPending && <>
      <Text accessibilityRole="alert">Received updates are saved, but this view could not refresh.</Text>
      {button('Retry cooking refresh', () => run(retryRefresh), busy)}
    </>}
  </View>;
}

const styles = StyleSheet.create({
  group:{gap:8}, actions:{flexDirection:'row', flexWrap:'wrap', gap:8},
  button:{alignSelf:'flex-start', paddingHorizontal:10, paddingVertical:7, borderWidth:1, borderColor:'#94a3b8', borderRadius:6},
  disabled:{opacity:0.5}, input:{borderWidth:1, borderColor:'#94a3b8', borderRadius:6, padding:8},
  signal:{maxHeight:95, fontFamily:'monospace', fontSize:12, borderWidth:1, borderColor:'#94a3b8', padding:6, overflow:'scroll'},
});
