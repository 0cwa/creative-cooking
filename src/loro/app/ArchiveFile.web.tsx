import React from 'react';
import {palette,useColorSchemeValue} from '@/theme/StyleSheet';
export function ArchiveFile({onFile,download,disabled}:{onFile:(file:File|null)=>void;download:string|null;disabled:boolean}){
 const colors=palette(useColorSchemeValue());
 const font={fontFamily:'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',fontSize:14,lineHeight:'21px',color:colors.text};
 return <div style={font}><label style={{display:'flex',flexDirection:'column',gap:6,alignItems:'flex-start'}}>Choose encrypted archive file <input style={{...font,colorScheme:'inherit'}} aria-label="Choose encrypted archive file" type="file" disabled={disabled} accept="application/json,.json" onChange={event=>onFile(event.currentTarget.files?.[0]??null)}/></label>{download?<p style={{margin:'8px 0 0'}}><a style={{color:colors.text,fontWeight:700}} href={download} download="creative-cooking-personal-recovery.json">Download encrypted archive</a></p>:null}</div>;
}
export function archiveDownload(text:string){return URL.createObjectURL(new Blob([text],{type:'application/json'}));}
export function releaseArchiveDownload(url:string){URL.revokeObjectURL(url);}
