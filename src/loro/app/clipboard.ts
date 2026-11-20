import * as Clipboard from 'expo-clipboard';
export const copyText=(text:string):Promise<boolean>=>Clipboard.setStringAsync(text);
