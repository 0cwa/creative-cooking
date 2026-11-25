import {Platform} from 'react-native';
import {Pressable,Text} from '@/theme/primitives';
import {chooseExchangeFile,saveExchangeFile} from './exchange-file';

type Controls = {label:string; limit:number; run:(action:()=>Promise<void>)=>void; disabled?:boolean};
type Props = Controls & ({outgoing:string} | {onRead:(message:string)=>void});
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8',{fatal:true});

/** Public admission messages can cross devices through a JSON file. */
export function PublicMessageFile(props:Props) {
  if (Platform.OS !== 'android') return null;
  const {label,limit,run,disabled} = props;
  const share = 'outgoing' in props;
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={() => run(async () => {
    if ('outgoing' in props) {
      const bytes = encoder.encode(props.outgoing);
      if (bytes.length > limit) throw Error('This message is too large to share.');
      await saveExchangeFile(`creative-cooking-${label.replaceAll(' ','-')}.json`,'application/json',bytes);
    } else {
      const bytes = await chooseExchangeFile({accept:['application/json','text/plain'],minBytes:1,maxBytes:limit});
      if (bytes) props.onRead(decoder.decode(bytes));
    }
  })}><Text>{share ? `Share ${label} file` : `Choose ${label} file`}</Text></Pressable>;
}
