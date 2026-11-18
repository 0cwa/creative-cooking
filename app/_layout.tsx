import {LockedWorkspace} from '@/loro/app/LockedWorkspace';
import {RecoveryStart} from '@/loro/app/RecoveryStart';
import {PolicySetup} from '@/loro/disclosure/PolicySetup';
import {AdmissionRulePicker, admissionPolicyFromDraft, type AdmissionRuleDraft} from '@/loro/app/AdmissionRulePicker';
import {validAdmissionPolicy} from '@/loro/authority/validator.mjs';
import {initialAdmissionPolicy} from '@/loro/app/admission-rule.mjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Platform, ScrollView, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppStateProvider, useAppState } from '@/state/AppState';
import { FirstOpenLoadingAnimation } from '@/components/FirstOpenLoadingAnimation';
import { InstallAppPrompt } from '@/components/InstallAppPrompt';
import { finishOpenRouterOAuthFromLocation } from '@/llm/openrouter/oauth';
import { importSharedOpenRouterKey } from '@/llm/openrouter/share';
import { requestPersistentStorageOnce } from '@/storage/persistence';
import { initializeAccountWorkspace } from '@/account/accountWorkspace';

function StorageFailureAlert() {
  const { storageError, storageMode } = useAppState();
  const shownError = useRef<string | null>(null);

  useEffect(() => {
    if (!storageError) {
      shownError.current = null;
      return;
    }
    if (shownError.current === storageError) return;
    shownError.current = storageError;
    Alert.alert(
      'Local data is not being saved',
      storageMode === 'fresh-local' ? `${storageError}\n\nYour current changes remain open in this session and are not saved. This preview does not yet provide an export.` : `${storageError}\n\nYour current changes remain open in this session. Open Settings → Data & Storage to retry or export a backup.`
    );
  }, [storageError, storageMode]);

  return null;
}

function BootTasks() {
  const app = useAppState();

  useEffect(() => {
    if (!app.hydrated) return;

    void (async () => {
      try {
        const imported = await importSharedOpenRouterKey();
        if (imported) {
          app.updateSettings({ providerId: 'openrouter', model: 'openrouter/free' });
          Alert.alert(
            'Shared OpenRouter key connected',
            'This browser can now use the shared provider key. Anyone with the complete share link can use that key until it is revoked.'
          );
        }
      } catch (error) {
        Alert.alert('Could not import shared key', error instanceof Error ? error.message : 'Unknown error');
      }

      try {
        const connected = await finishOpenRouterOAuthFromLocation();
        if (connected) {
          app.updateSettings({ providerId: 'openrouter', model: 'openrouter/free' });
          Alert.alert('OpenRouter connected', 'The Chef can now use your OpenRouter account.');
        }
      } catch (error) {
        Alert.alert('OpenRouter sign-in failed', error instanceof Error ? error.message : 'Unknown error');
      }

      try {
        await requestPersistentStorageOnce();
      } catch {
        // Persistence is a best-effort browser capability; backup/restore remains available.
      }
    })();
  }, [app.hydrated]);
  return null;
}

function AccountWorkspaceBootstrap() {
  useEffect(() => {
    void initializeAccountWorkspace();
  }, []);
  return null;
}

const webChoiceKey = 'creative-cooking-storage-choice-v1';
const webLegacyPreferenceKey = 'creative-cooking-legacy-preference-v1';
const webChoiceLock = 'creative-cooking/web-workspace-choice/v1';
const webWorkspaceKey = 'creative-cooking-local-workspace-v1';
const branchReopenKey = 'creative-cooking-branch-reopen-v1';
const pendingPrefix = 'pending:';
type BranchReopen = {scopeId:string;head:string;kind?:'personal';authorizationSnapshot?:string};

async function verifyBranchReopen(workspace:any, expected:BranchReopen|null) {
  if(!expected)return;
  const personal=expected.kind==='personal';
  const scope=personal?workspace?.personal?.scope:workspace?.household?.scope;
  const error=()=>Error(`The ${personal?'personal':'household'} branch changed before it could reopen. Retry to review the current workspace.`);
  if(scope?.scopeId!==expected.scopeId||scope.branchHead!==expected.head)throw error();
  try {
    if(personal){
      const authorized=await workspace.personal.authorize();
      if(expected.authorizationSnapshot&&authorized.record.authorizationSnapshot!==expected.authorizationSnapshot)throw error();
    }
    else await workspace.authorizeHousehold();
  } catch {
    throw error();
  }
}

function readPendingWebChoice(mode: string) {
  const record = JSON.parse(mode.slice(pendingPrefix.length));
  if (!record || Object.keys(record).sort().join(',') !== 'name,policy,version' ||
    record.version !== 1 || typeof record.name !== 'string' ||
    !/^cooking-[a-f0-9-]{36}$/.test(record.name) || !validAdmissionPolicy(record.policy,1)) throw Error('Invalid pending workspace');
  return {name:record.name as string,policy:initialAdmissionPolicy(record.policy)};
}

export default function RootLayout() {
  const [choice,setChoice]=useState<'loading'|'choose'|'locked'|'legacy'|'local'|'policy'>('loading');
  const [workspace,setWorkspace]=useState<any>(null);
  const [openAttempt,setOpenAttempt]=useState(0);
  const [error,setError]=useState<string|null>(null);
  const [admissionRule,setAdmissionRule]=useState<AdmissionRuleDraft>({kind:'allMinusOne',count:'1'});
  const pendingReopen=useRef<BranchReopen|null>(null);
  const admissionPolicy=admissionPolicyFromDraft(admissionRule);
  const reopenWorkspace=useCallback((expected?:BranchReopen)=>{
    if(Platform.OS==='web'){
      try{
        if(expected)globalThis.sessionStorage.setItem(branchReopenKey,JSON.stringify(expected));
        globalThis.location.assign(`${(process.env.EXPO_PUBLIC_BASE_URL??'').replace(/\/$/,'')}/`);
        return;
      }catch(error){
        if(!expected)throw error;
      }
    }
    pendingReopen.current=expected?{...expected}:null;
    setWorkspace(null);
    setError(null);
    setChoice('loading');
    setOpenAttempt(attempt=>attempt+1);
  },[]);
  useEffect(()=>()=>workspace?.close(),[workspace]);
  useEffect(()=>{let active=true;void (async()=>{
    if(Platform.OS==='android'){
      let opened:any=null,adopted=false;
      try{
        const {nativeChoiceStore}=await import('@/loro/native/choice-store');
        opened=await nativeChoiceStore.open();
        await verifyBranchReopen(opened,pendingReopen.current);
        if(!active)return;
        pendingReopen.current=null;
        if(opened){
          setWorkspace({...opened,reopen:reopenWorkspace});
          setChoice(opened.needsDisclosureSetup?'policy':'local');
          adopted=true;
        }else setChoice('choose');
      }catch(e){if(active){setError(e instanceof Error?e.message:'Could not open this workspace');setChoice('locked')}}
      finally{if(opened&&!adopted)opened.close()}
      return;
    }
    if(Platform.OS!=='web'){if(active)setChoice('choose');return;}
    let opened:any=null,adopted=false,expected=pendingReopen.current,confirmation:string|null=null;
    try{
      try{confirmation=globalThis.sessionStorage?.getItem(branchReopenKey)??null}catch{/* Ordinary startup also works without session storage. */}
      if(!expected&&confirmation!==null)expected=JSON.parse(confirmation);
      const mode=globalThis.localStorage.getItem(webChoiceKey);
      if(expected&&!mode?.startsWith('local:'))await verifyBranchReopen(null,expected);
      if(mode==='legacy'||(mode===null&&globalThis.localStorage.getItem(webLegacyPreferenceKey)==='legacy')){
        if(active)setChoice('legacy');
        return;
      }
      if(mode&&(mode.startsWith('local:')||mode.startsWith(pendingPrefix))){
        const pending=mode.startsWith(pendingPrefix)?readPendingWebChoice(mode):null;
        const name=pending?.name??mode.slice(6);
        const {openLocalWorkspace}=await import('@/loro/app/bootstrap');
        opened=pending?await openLocalWorkspace(name,true,pending.policy):await openLocalWorkspace(name);
        await verifyBranchReopen(opened,expected);
        if(active){
          const ready=`local:${name}`,current=globalThis.localStorage.getItem(webChoiceKey);
          if(current!==mode&&current!==ready)throw Error('Workspace choice changed while opening.');
          globalThis.localStorage.setItem(webWorkspaceKey,name);
          if(pending&&current!==ready)globalThis.localStorage.setItem(webChoiceKey,ready);
          if(confirmation!==null)globalThis.sessionStorage.removeItem(branchReopenKey);
          pendingReopen.current=null;
          setWorkspace({...opened,reopen:reopenWorkspace});setChoice(opened.needsDisclosureSetup?'policy':'local');adopted=true;
        }
        return;
      }
      if(active)setChoice('choose');
    }catch(e){if(active){setError(e instanceof Error?e.message:'Could not open this workspace');setChoice('locked')}}
    finally{if(opened&&!adopted)opened.close()}
  })();return()=>{active=false}},[openAttempt,reopenWorkspace]);
  const legacy=async()=>{
    try{
      if(Platform.OS==='web'){
        const locks=globalThis.navigator?.locks;
        if(!locks)globalThis.localStorage.setItem(webLegacyPreferenceKey,'legacy');
        else await locks.request(webChoiceLock,()=>{
          const mode=globalThis.localStorage.getItem(webChoiceKey);
          if(!mode?.startsWith(pendingPrefix)&&!mode?.startsWith('local:'))globalThis.localStorage.setItem(webChoiceKey,'legacy');
        });
      }
    }catch{Alert.alert('Workspace choice was not saved','Your existing workspace will open for this session. This browser could not remember your selection.')}
    setChoice('legacy');
  };
  const fresh=async()=>{
    setChoice('loading');setError(null);
    try{
      if(Platform.OS==='android'){
        const {nativeChoiceStore}=await import('@/loro/native/choice-store');
        const opened=await nativeChoiceStore.create(admissionPolicy);
        setWorkspace({...opened,reopen:reopenWorkspace});setChoice(opened.needsDisclosureSetup?'policy':'local');
        return;
      }
      const policy=initialAdmissionPolicy(admissionPolicy);
      const locks=globalThis.navigator?.locks;
      if(!locks)throw Error('LOCK_UNAVAILABLE');
      await locks.request(webChoiceLock,()=>{
        const mode=globalThis.localStorage.getItem(webChoiceKey);
        if(mode?.startsWith(pendingPrefix)||mode?.startsWith('local:'))return;
        const record={version:1,name:`cooking-${crypto.randomUUID()}`,policy};
        globalThis.localStorage.setItem(webChoiceKey,pendingPrefix+JSON.stringify(record));
      });
      setOpenAttempt(attempt=>attempt+1);
    }catch(e){setError(e instanceof Error?e.message:'Could not create local workspace');setChoice(Platform.OS==='android'?'locked':'choose')}
  };
  const returnToOriginal=async()=>{
    setChoice('loading');
    try{
      const {nativeChoiceStore}=await import('@/loro/native/choice-store');
      await nativeChoiceStore.returnToOriginal();
      reopenWorkspace();
    }catch(e){
      setError(e instanceof Error?e.message:'Could not return to the original household');
      setChoice('locked');
    }
  };
  if(choice==='loading')return <View><Text>Opening your cooking workspace…</Text></View>;
  if(choice==='locked')return <SafeAreaProvider><LockedWorkspace error={error} onRetry={()=>{
    if(pendingReopen.current){setChoice('loading');setOpenAttempt(attempt=>attempt+1)}
    else if(Platform.OS==='web')globalThis.location.reload();
    else reopenWorkspace();
  }} onLegacy={()=>setChoice('legacy')} onOriginal={Platform.OS==='android'?()=>void returnToOriginal():undefined}/></SafeAreaProvider>;
  if(choice==='policy')return <SafeAreaProvider><ScrollView contentContainerStyle={{padding:24,gap:16}}><Text>Your household policy applies to new cooking changes. Existing items are not automatically approved for external processing.</Text><PolicySetup service={workspace.disclosure} provider={workspace.disclosureProvider} deviceId={workspace.deviceId} onAccepted={()=>setChoice('local')}/></ScrollView></SafeAreaProvider>;
  if(choice==='choose')return <SafeAreaProvider><ScrollView contentContainerStyle={{padding:24,gap:16}}><Text accessibilityRole="header" style={{fontSize:24}}>Choose a cooking workspace</Text><Text>Your existing workspace remains available. A fresh local preview starts empty and keeps its data separately. The preview saves recipes, pantry, shopping and personal settings. Chef requests are not yet supported.</Text>{error?<Text>{error}</Text>:null}<Button title="Open existing workspace" onPress={legacy}/>{Platform.OS==='web'?<RecoveryStart/>:null}{(Platform.OS==='web'||Platform.OS==='android')?<><AdmissionRulePicker draft={admissionRule} onChange={setAdmissionRule} adults={1}/><Button title="Start fresh local preview" disabled={!validAdmissionPolicy(admissionPolicy,1)} onPress={()=>void fresh()}/></>:<Text>The fresh local preview is not available on this platform.</Text>}</ScrollView></SafeAreaProvider>;
  return (
    <SafeAreaProvider>
      <AppStateProvider key={choice} localWorkspace={workspace}>
        {choice==='legacy'?<><BootTasks /><AccountWorkspaceBootstrap /></>:null}
        <StorageFailureAlert />
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="shopping" />
        </Stack>
        <InstallAppPrompt />
        <FirstOpenLoadingAnimation />
      </AppStateProvider>
    </SafeAreaProvider>
  );
}
