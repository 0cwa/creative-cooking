import {LockedWorkspace} from '@/loro/app/LockedWorkspace';
import {RecoveryStart} from '@/loro/app/RecoveryStart';
import {PolicySetup} from '@/loro/disclosure/PolicySetup';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Platform, Text, View } from 'react-native';
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

export default function RootLayout() {
  const [choice,setChoice]=useState<'loading'|'choose'|'locked'|'legacy'|'local'|'policy'>('loading');
  const [workspace,setWorkspace]=useState<any>(null);
  const [openAttempt,setOpenAttempt]=useState(0);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{let active=true;void (async()=>{
    if(Platform.OS==='android'){try{const {nativeChoiceStore}=await import('@/loro/native/choice-store');const opened=await nativeChoiceStore.open();if(!active){opened?.close();return}if(opened){setWorkspace(opened);setChoice(opened.needsDisclosureSetup?'policy':'local')}else setChoice('choose')}catch(e){if(active){setError(e instanceof Error?e.message:'Could not open this workspace');setChoice('locked')}}return;}
    if(Platform.OS!=='web'){if(active)setChoice('choose');return;}
    let opened:any=null,adopted=false;
    try{
      const mode=globalThis.localStorage.getItem('creative-cooking-storage-choice-v1');
      if(mode==='legacy'){if(active)setChoice('legacy');return;}
      if(mode?.startsWith('local:')){
        const {openLocalWorkspace}=await import('@/loro/app/bootstrap');
        opened=await openLocalWorkspace(mode.slice(6));
        if(active){
          globalThis.localStorage.setItem('creative-cooking-local-workspace-v1',mode.slice(6));
          setWorkspace(opened);setChoice(opened.needsDisclosureSetup?'policy':'local');adopted=true;
        }
        return;
      }
      if(active)setChoice('choose');
    }catch(e){if(active){setError(e instanceof Error?e.message:'Could not open this workspace');setChoice('locked')}}
    finally{if(opened&&!adopted)opened.close()}
  })();return()=>{active=false}},[openAttempt]);
  const legacy=()=>{try{if(Platform.OS==='web')globalThis.localStorage.setItem('creative-cooking-storage-choice-v1','legacy')}catch{Alert.alert('Workspace choice was not saved','Your existing workspace will open for this session. This browser could not remember your selection.')}setChoice('legacy')};
  const fresh=async()=>{setChoice('loading');setError(null);let opened:any=null,adopted=false;try{if(Platform.OS==='android'){const {nativeChoiceStore}=await import('@/loro/native/choice-store');opened=await nativeChoiceStore.create();setWorkspace(opened);setChoice(opened.needsDisclosureSetup?'policy':'local');adopted=true;return}const {openLocalWorkspace}=await import('@/loro/app/bootstrap');const name=`cooking-${crypto.randomUUID()}`;opened=await openLocalWorkspace(name,true);globalThis.localStorage.setItem('creative-cooking-local-workspace-v1',name);globalThis.localStorage.setItem('creative-cooking-storage-choice-v1',`local:${name}`);setWorkspace(opened);setChoice(opened.needsDisclosureSetup?'policy':'local');adopted=true}catch(e){setError(e instanceof Error?e.message:'Could not create local workspace');setChoice(Platform.OS==='android'?'locked':'choose')}finally{if(opened&&!adopted)opened.close()}};
  if(choice==='loading')return <View><Text>Opening your cooking workspace…</Text></View>;
  if(choice==='locked')return <SafeAreaProvider><LockedWorkspace error={error} onRetry={()=>{if(Platform.OS==='web')globalThis.location.reload();else{setChoice('loading');setOpenAttempt(x=>x+1)}}} onLegacy={()=>setChoice('legacy')}/></SafeAreaProvider>;
  if(choice==='policy')return <SafeAreaProvider><View style={{padding:24,gap:16}}><Text>Your household policy applies to new cooking changes. Existing items are not automatically approved for external processing.</Text><PolicySetup service={workspace.disclosure} provider={workspace.disclosureProvider} deviceId={workspace.deviceId} onAccepted={()=>setChoice('local')}/></View></SafeAreaProvider>;
  if(choice==='choose')return <SafeAreaProvider><View style={{padding:24,gap:16}}><Text accessibilityRole="header" style={{fontSize:24}}>Choose a cooking workspace</Text><Text>Your existing workspace remains available. A fresh local preview starts empty and keeps its data separately. The preview saves recipes, pantry, shopping and personal settings. Chef requests are not yet supported.</Text>{error?<Text>{error}</Text>:null}<Button title="Open existing workspace" onPress={legacy}/>{Platform.OS==='web'?<RecoveryStart/>:null}{(Platform.OS==='web'||Platform.OS==='android')?<Button title="Start fresh local preview" onPress={()=>void fresh()}/>:<Text>The fresh local preview is not available on this platform.</Text>}</View></SafeAreaProvider>;
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
