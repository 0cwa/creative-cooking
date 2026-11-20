// Translate a captured pantry edit into field-level semantic commands. The
// authenticated document supplies current effect dependencies at planning time.
const named=(kind,id)=>`${kind}:${encodeURIComponent(id)}`;
const head=(kind,id,field)=>named('field-head',JSON.stringify([kind,id,field]));
export function planPantryAction({doc,before,after,actionId,author,at}) {
 if(!doc||!Array.isArray(before)||!Array.isArray(after)||typeof actionId!=='string'||!actionId||typeof author!=='string'||!author||!Number.isFinite(Date.parse(at)))throw Error('MALFORMED');
 const old=new Map(before.map(x=>[x.id,x])),next=new Map(after.map(x=>[x.id,x]));
 if(old.size!==before.length||next.size!==after.length)throw Error('MALFORMED');
 const commands=[];let index=0;
 const add=(kind,data,deps=[])=>{const effectId=`${actionId}:${++index}`;commands.push({version:1,kind,commandId:effectId,effectId,dependencyEffectIds:[...new Set(deps)].sort(),data});return effectId};
 for(const id of [...new Set([...old.keys(),...next.keys()])].sort()) {
  const a=old.get(id),b=next.get(id),current=doc.getMap('pantry-index').get(id);
  if(!a&&b) {
   if(current)throw Error('CONFLICT');
   const created=add('pantry-create',{itemId:id,name:b.name,preference:b.preference,at:b.createdAt,author});
   if(b.updatedAt!==b.createdAt)add('pantry-field',{itemId:id,field:'updatedAt',value:b.updatedAt,author,at},[created]);
  } else if(a&&!b) {
   if(!current)throw Error('CONFLICT');const live=doc.getMap(named('pantry',id)).toJSON();if(['name','preference','createdAt','updatedAt'].some(field=>live[field]!==a[field]))throw Error('REBASE_REQUIRED');const previous=doc.getMap(head('pantry',id,'removedAt')).get('effect');add('pantry-field',{itemId:id,field:'removedAt',value:at,author,at},[current,...(previous?[previous]:[])]);
  } else if(a&&b) {
   if(!current)throw Error('CONFLICT');
   if(a.createdAt!==b.createdAt)throw Error('UNSUPPORTED_EDIT');
   const live=doc.getMap(named('pantry',id)).toJSON();if(['name','preference','updatedAt'].some(field=>a[field]!==b[field]&&live[field]!==a[field]))throw Error('REBASE_REQUIRED');
   for(const field of ['name','preference','updatedAt'])if(a[field]!==b[field]){const previous=doc.getMap(head('pantry',id,field)).get('effect');add('pantry-field',{itemId:id,field,value:b[field],author,at},[current,...(previous?[previous]:[])]);}
  }
 }
 return commands;
}
