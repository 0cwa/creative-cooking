import React from 'react';
export function ArchiveFile({onFile,download,disabled}:{onFile:(file:File|null)=>void;download:string|null;disabled:boolean}){
 return <div><label>Choose encrypted archive file <input aria-label="Choose encrypted archive file" type="file" disabled={disabled} accept="application/json,.json" onChange={event=>onFile(event.currentTarget.files?.[0]??null)}/></label>{download?<p><a href={download} download="creative-cooking-personal-recovery.json">Download encrypted archive</a></p>:null}</div>;
}
export function archiveDownload(text:string){return URL.createObjectURL(new Blob([text],{type:'application/json'}));}
export function releaseArchiveDownload(url:string){URL.revokeObjectURL(url);}
