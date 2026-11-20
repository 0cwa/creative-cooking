import React,{useEffect,useMemo} from 'react';
export function RecoveryDownload({archive}:{archive:unknown}){const url=useMemo(()=>URL.createObjectURL(new Blob([JSON.stringify(archive)],{type:'application/json'})),[archive]);useEffect(()=>()=>URL.revokeObjectURL(url),[url]);return <a href={url} download="creative-cooking-guardian-recovery.json">Download encrypted personal archive</a>}
