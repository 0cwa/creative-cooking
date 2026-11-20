import React,{useEffect,useState} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import {ArchiveFile,archiveDownload,releaseArchiveDownload} from './ArchiveFile';
import {MAX_ARCHIVE_TEXT,parseRecoveryArchiveText,readRecoveryArchiveFile} from './recovery-input.mjs';
const MAX_PASTE=64*1024;
export type RecoveryView={status:{missingObjects:string[];archiveAccess:string;archiveCiphertextCopies?:number;recoverableKeys?:number;availableObjects?:string[]};personal:null|{preferences:Record<string,unknown>;conversations:{id:string;title:string;messages:{id:string;content?:unknown}[]}[]}};
type Props={createLabel?:string;restoreLabel?:string;read?:()=>Promise<RecoveryView|null>;create?:()=>Promise<{code:string;archive:unknown}>;restore?:(archive:unknown,code:string)=>Promise<RecoveryView>};
/** The caller supplies the accepted workspace or a fresh destination; this panel never chooses either. */
export function PersonalRecoveryPanel({create,restore,read,createLabel,restoreLabel}:Props){
 const [paste,setPaste]=useState(''),[file,setFile]=useState<File|null>(null),[download,setDownload]=useState<string|null>(null),[code,setCode]=useState(''),[view,setView]=useState<RecoveryView|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>()=>{if(download)releaseArchiveDownload(download)},[download]);
 useEffect(()=>{
  if(!read)return;
  let active=true;
  void read().then(value=>{if(active)setView(value)},()=>{if(active)setError('The saved personal copy could not be opened.')});
  return()=>{active=false};
 },[read]);
 const clear=()=>{setView(null);setError('')};
 const act=async(fn:()=>Promise<void>)=>{setBusy(true);clear();try{await fn()}catch(e){setError(e instanceof Error&&e.message==='TOO_LARGE'?'Archive is too large. Choose a smaller archive file.':'Recovery could not be completed. Check the code and archive, then try again.')}finally{setBusy(false)}};
 return <View style={{gap:10}}><Text accessibilityRole="header">Personal recovery</Text><Text>Keep the recovery code and encrypted archive separately. The archive contains a private data copy only if one was available when it was created. The archive contains private message history and other content you entered. The encrypted update inventory covers the active epoch; historical-epoch ciphertext is excluded.</Text>
 {create?<Pressable accessibilityRole="button" disabled={busy} onPress={()=>void act(async()=>{const result=await create(),text=JSON.stringify(result.archive);if(new TextEncoder().encode(text).length>=MAX_ARCHIVE_TEXT)throw Error('TOO_LARGE');setCode(result.code);setDownload(archiveDownload(text));})}><Text>{createLabel??'Create recovery code and archive'}</Text></Pressable>:null}
 <Text>Recovery code</Text><TextInput accessibilityLabel="Recovery code" value={code} onChangeText={value=>{setCode(value);clear()}} autoCapitalize="none" autoCorrect={false} editable={!busy} />
 <ArchiveFile disabled={busy} download={download} onFile={value=>{setFile(value);setPaste('');clear()}}/>{file?<Text>Selected archive: {file.name} ({file.size} bytes)</Text>:null}
 {restore?<><Text>Or paste a small encrypted archive (up to 64 KiB)</Text><TextInput accessibilityLabel="Encrypted archive" value={paste} onChangeText={value=>{setPaste(value);setFile(null);clear()}} maxLength={MAX_PASTE} multiline editable={!busy} /><Pressable accessibilityRole="button" disabled={busy||!code||(!file&&!paste)} onPress={()=>void act(async()=>{if(!file&&paste.length>=MAX_PASTE)throw Error('TOO_LARGE');const archive=file?await readRecoveryArchiveFile(file):parseRecoveryArchiveText(paste);setView(await restore(archive,code));})}><Text>{restoreLabel??'Restore personal archive'}</Text></Pressable></>:null}
 {error?<Text accessibilityRole="alert">{error}</Text>:null}
 {view?<View style={{gap:6}}><Text accessibilityRole="header">Recovered personal archive</Text><Text>{view.status.archiveAccess==='snapshot-available-read-only'?'Private data copy available to read.':'No private data copy was included.'}</Text><Text>{view.status.recoverableKeys!==undefined?`Recoverable personal keys: ${view.status.recoverableKeys}. Available encrypted updates on this device: ${view.status.availableObjects?.length??0}. `:null}{view.status.missingObjects.length} catalogued encrypted updates are not installed on this device. {view.status.archiveCiphertextCopies??0} encrypted update copies are in the archive. This archive grants no current personal write authority. Household access requires readmission.</Text>{view.personal?<><Text accessibilityRole="header">Preferences</Text>{Object.entries(view.personal.preferences).map(([key,value])=><Text key={key}>{key}: {String(value)}</Text>)}<Text accessibilityRole="header">Conversations</Text>{view.personal.conversations.map(c=><View key={c.id}><Text>{c.title}</Text>{c.messages.map(m=><Text key={m.id}>{typeof m.content==='string'?m.content:JSON.stringify(m.content)}</Text>)}</View>)}</>:null}</View>:null}
 </View>;
}
