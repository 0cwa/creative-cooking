import {useContext,useEffect,useState} from 'react';
import {Platform,Pressable,Text,View} from 'react-native';
import {useAppState} from '@/state/AppState';
import {MAX_OBJECT} from '../transport/adapter.mjs';
import {chooseExchangeFile,saveExchangeFile} from './exchange-file';
import {LoroWorkspaceValue} from './WorkspaceStatus';

/** Explicit foreground file exchange. A file handoff does not provide a peer receipt. */
export function CookingExchange({quarantineChanged = 0}:{quarantineChanged?:number}) {
  const workspace = useContext(LoroWorkspaceValue), app = useAppState();
  const [open,setOpen] = useState(false), [rows,setRows] = useState<any[]>([]), [pending,setPending] = useState<any[]>([]);
  const [status,setStatus] = useState(''), [busy,setBusy] = useState(false);
  const web = Platform.OS === 'web';

  async function refresh() {
    const [outbound,inbox] = await Promise.all([workspace.cookingFiles.list(),workspace.cookingFiles.pending()]);
    setRows(outbound);
    setPending(inbox);
  }
  useEffect(() => {
    if (open) void refresh().catch(() => setStatus('Could not list updates.'));
  }, [quarantineChanged]);
  function run(fn:()=>Promise<void>, failure:string) {
    setStatus('');
    setBusy(true);
    void fn().catch(async error => {
      if (error?.message === 'QUARANTINED') {
        setStatus('Update blocked by local device quarantine. No update was applied.');
        await refresh().catch(() => {});
      } else if (error?.message === 'RECIPE_CREATION_REQUIRED') {
        setStatus('Choose the encrypted file that created this recipe first, then choose this edit again.');
      } else setStatus(`${failure}${error instanceof Error ? `: ${error.message}` : ''}.`);
    })
      .finally(() => setBusy(false));
  }
  async function exportUpdate(id:string) {
    const {selection,selectedHousehold} = workspace.householdPairing;
    const download = () => workspace.cookingFiles.download(id);
    const bytes = web
      ? await selection.withCurrent(selectedHousehold ? workspace.household.scope.scopeId : null, download)
      : await download();
    await saveExchangeFile('creative-cooking-update.bin','application/octet-stream',bytes);
    setStatus(web ? 'Encrypted update downloaded. This does not confirm that a peer received it.' : 'Encrypted update ready to share.');
  }
  async function applyUpdate(apply:()=>Promise<{status?:string;replayed?:boolean}>) {
    const {selection,selectedHousehold} = workspace.householdPairing;
    const update = async () => {
      const release = app.beginWorkspaceTransition();
      let reloadRequested = false;
      try {
        if (app.localPersistenceStatus === 'error') throw Error('Retry local saving before receiving an update');
        await app.flushCurrentWorkspace();
        const result = web
          ? await selection.withCurrent(selectedHousehold ? workspace.household.scope.scopeId : null, apply)
          : await apply();
        if (result.replayed) {
          let message = 'This exact update was already applied. No new changes were made.';
          try { await app.refreshSharedCooking?.(); }
          catch { message += ' Retry cooking refresh to update this view.'; }
          setStatus(message);
          return;
        }
        if (result.status === 'pending') {
          setStatus('The encrypted update is retained, awaiting policy governance proof.');
          await refresh().catch(() => {});
          return;
        }
        if (web) {
          try {
            globalThis.location.reload();
            reloadRequested = true;
          } catch {
            setStatus('The encrypted update was applied. Reload to update this view.');
          }
          return;
        }
        let message = 'The encrypted update was applied.';
        try {
          await app.refreshSharedCooking?.();
        } catch {
          message += ' Retry cooking refresh to update this view.';
        }
        setStatus(message);
        try { await refresh(); }
        catch { setStatus(`${message} Refresh the update list to try again.`); }
      } finally { if (!reloadRequested) release(); }
    };
    await update();
  }
  async function choose() {
    const bytes = await chooseExchangeFile({accept:['application/octet-stream','application/x-binary'],minBytes:1,maxBytes:MAX_OBJECT});
    if (bytes) await applyUpdate(() => workspace.cookingFiles.receive(bytes));
  }

  return <View style={{gap:6}}>
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => {setOpen(!open); if (!open) run(refresh,'Could not list updates');}}>
      <Text>{open ? 'Close cooking file exchange' : 'Exchange encrypted cooking files'}</Text>
    </Pressable>
    {open && <>
      <Text>Exchange one encrypted update file at a time with an authorized household member. Apply any required earlier updates first.</Text>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => run(refresh,'Could not list updates')}><Text>Refresh retained cooking updates</Text></Pressable>
      {rows.map(row => <View key={row.objectId}>
        <Text selectable>{row.objectId}</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => run(() => exportUpdate(row.objectId),'Could not share update')}>
          <Text>{web ? 'Download' : 'Share'} encrypted update {row.objectId}</Text>
        </Pressable>
      </View>)}
      {pending.map(item => <View key={item.itemId}>
        <Text>{item.reason === 'QUARANTINED' ? `Retained update blocked by local device quarantine: ${item.itemId}` :
          `Retained update awaiting application: ${item.itemId}${item.reason === 'POLICY_GOVERNANCE_UNPROVEN' ? ' · policy governance proof required' : ' · retry after any missing earlier updates'}`}</Text>
        {item.reason !== 'QUARANTINED' && <Pressable accessibilityRole="button" disabled={busy || !app.canEditSharedContent} onPress={() => run(() => applyUpdate(() => workspace.cookingFiles.retry(item.itemId)),'Could not apply retained update')}>
          <Text>Retry retained update {item.itemId}</Text>
        </Pressable>}
      </View>)}
      <Pressable accessibilityRole="button" disabled={busy || !app.canEditSharedContent} onPress={() => run(choose,'Update not applied')}><Text>Choose encrypted cooking update</Text></Pressable>
      {!!status && <Text accessibilityRole="alert">{status}</Text>}
    </>}
  </View>;
}
