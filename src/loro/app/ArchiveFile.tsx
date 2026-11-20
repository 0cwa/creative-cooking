import React from 'react';import {Text} from 'react-native';
export function ArchiveFile(_props:{onFile:(file:File|null)=>void;download:string|null;disabled:boolean}){return <Text>Archive files are not available on this platform yet.</Text>}
export function archiveDownload(_text:string):string{throw Error('UNAVAILABLE')}
export function releaseArchiveDownload(_url:string){}
