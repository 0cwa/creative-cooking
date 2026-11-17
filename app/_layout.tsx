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
  const [choice,setChoice]=useState<'loading'|'choose'|'locked'|'legacy'|'local'>('loading');
  const [workspace,setWorkspace]=useState<any>(null);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{let active=true;void (async()=>{
    if(Platform.OS!=='web'){if(active)setChoice('choose');return;}
    const mode=globalThis.localStorage.getItem('creative-cooking-storage-choice-v1');
    if(mode==='legacy'){if(active)setChoice('legacy');return;}
    if(mode?.startsWith('local:')){try{const {openLocalWorkspace}=await import('@/loro/app/bootstrap');const opened=await openLocalWorkspace(mode.slice(6));if(active){globalThis.localStorage.setItem('creative-cooking-local-workspace-v1',mode.slice(6));setWorkspace(opened);setChoice('local')}else opened.close()}catch(e){if(active){setError(e instanceof Error?e.message:'Could not open this workspace');setChoice('locked')}}return;}
    if(active)setChoice('choose');
  })();return()=>{active=false}},[]);
  const legacy=()=>{if(Platform.OS==='web')globalThis.localStorage.setItem('creative-cooking-storage-choice-v1','legacy');setChoice('legacy')};
  const fresh=async()=>{setChoice('loading');setError(null);try{const {openLocalWorkspace}=await import('@/loro/app/bootstrap');const name=`cooking-${crypto.randomUUID()}`;const opened=await openLocalWorkspace(name,true);globalThis.localStorage.setItem('creative-cooking-local-workspace-v1',name);globalThis.localStorage.setItem('creative-cooking-storage-choice-v1',`local:${name}`);setWorkspace(opened);setChoice('local')}catch(e){setError(e instanceof Error?e.message:'Could not create local workspace');setChoice('choose')}};
  if(choice==='loading')return <View><Text>Opening your cooking workspace…</Text></View>;
  if(choice==='locked')return <SafeAreaProvider><View style={{padding:24,gap:16}}><Text accessibilityRole="header">Could not open the fresh local workspace</Text><Text>{error}</Text><Text>Your workspace has been kept. Retry after resolving the storage error.</Text><Button title="Retry" onPress={()=>globalThis.location.reload()}/><Button title="Open existing workspace for this session" onPress={()=>setChoice('legacy')}/></View></SafeAreaProvider>;
  if(choice==='choose')return <SafeAreaProvider><View style={{padding:24,gap:16}}><Text accessibilityRole="header" style={{fontSize:24}}>Choose a cooking workspace</Text><Text>Your existing workspace remains available. A fresh local preview starts empty and keeps its data separately. The preview saves recipes, pantry and personal settings. Shopping and Chef requests are not yet supported.</Text>{error?<Text>{error}</Text>:null}<Button title="Open existing workspace" onPress={legacy}/>{Platform.OS==='web'?<Button title="Start fresh local preview" onPress={()=>void fresh()}/>:<Text>The fresh local preview is not available on this platform.</Text>}</View></SafeAreaProvider>;
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
