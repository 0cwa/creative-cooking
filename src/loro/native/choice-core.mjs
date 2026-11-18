const KEY='creative-cooking-native-workspace-v1';
const validName=x=>typeof x==='string'&&/^cooking-[a-f0-9]{32}$/.test(x);
export function createNativeChoiceStore({read,write,random,openWorkspace,returnToOriginal}) {
 if(![read,write,random,openWorkspace].every(x=>typeof x==='function'))throw Error('MALFORMED');
 let queue=Promise.resolve();const exclusive=fn=>{const next=queue.catch(()=>{}).then(fn);queue=next.then(()=>{},()=>{});return next};
 const load=async()=>{const value=await read(KEY);if(value===null)return null;let record;try{record=JSON.parse(value)}catch{throw Error('LOCKED')}if(!record||Object.keys(record).sort().join(',')!=='name,stage,version'||record.version!==1||!['pending','ready'].includes(record.stage)||!validName(record.name))throw Error('LOCKED');return record};
 const resume=async record=>{const workspace=await openWorkspace(record.name,record.stage==='pending');try{if(record.stage==='pending')await write(KEY,JSON.stringify({...record,stage:'ready'}));return workspace}catch(e){workspace.close();throw e}};
 return {returnToOriginal:()=>exclusive(async()=>{
  const record=await load();
  if(record?.stage!=='ready')throw Error('MISSING_ESTABLISHED_WORKSPACE');
  await returnToOriginal(record.name);
 }),open:()=>exclusive(async()=>{const record=await load();return record?resume(record):null}),create:()=>exclusive(async()=>{if(await load())throw Error('CONFLICT');const name=`cooking-${random()}`;if(!validName(name))throw Error('MALFORMED');const record={version:1,stage:'pending',name};await write(KEY,JSON.stringify(record));return resume(record)})};
}
