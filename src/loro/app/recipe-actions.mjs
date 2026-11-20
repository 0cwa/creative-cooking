const named=(kind,id)=>`${kind}:${encodeURIComponent(id)}`;
const member=(kind,id,child)=>named(kind,JSON.stringify([id,child]));
const head=(kind,id,field)=>named('field-head',JSON.stringify([kind,id,field]));
const equal=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
/** Plan one recipe action from its authenticated current document. */
export function planRecipeAction({doc,before,after,actionId,author,at}) {
 if(!doc||(!before&&!after)||!actionId||!author||!Number.isFinite(Date.parse(at))||(before&&after&&before.id!==after.id))throw Error('MALFORMED');
 const id=(after??before).id,commands=[];let n=0;
 const add=(kind,data,deps=[])=>{const effectId=`${actionId}:${++n}`;commands.push({version:1,kind,commandId:effectId,effectId,dependencyEffectIds:[...new Set(deps)].sort(),data});return effectId};
 const root=doc.getMap('recipe-index').get(id);
 if(!before){if(root)throw Error('CONFLICT');add('recipe-create',{recipe:after,author,at:after.createdAt});return commands;}
 if(!root)throw Error('CONFLICT');
 const recipe=doc.getMap(named('recipe',id)).toJSON();
 if(!after){if(recipe.removed)throw Error('CONFLICT');const prev=doc.getMap(head('recipe',id,'removed')).get('effect');add('recipe-field',{recipeId:id,field:'removed',value:true,author,at},[root,...(prev?[prev]:[])]);return commands;}
 if(before.createdAt!==after.createdAt)throw Error('UNSUPPORTED_EDIT');
 for(const field of ['title','description','portions','notes','updatedAt']){
  const canonical=value=>value===undefined&&field==='description'?'':value===undefined&&field==='notes'?[]:value;
  const previous=canonical(before[field]),value=canonical(after[field]);
  // The editor omits blank optional fields. Compare the values Loro stores
  // so an unchanged field does not produce an unverifiable no-op update.
  if(equal(previous,value))continue;
  if(!equal(canonical(recipe[field]),previous))throw Error('REBASE_REQUIRED');
  if(value===undefined)throw Error('UNSUPPORTED_EDIT');
  const prev=doc.getMap(head('recipe',id,field)).get('effect');add('recipe-field',{recipeId:id,field,value,author,at},[root,...(prev?[prev]:[])]);
 }
 const beforeIngredients=new Map(before.ingredients.map((x,i)=>[x.id,{...x,position:i}])),afterIngredients=new Map(after.ingredients.map((x,i)=>[x.id,{...x,position:i}]));
 if(beforeIngredients.has(undefined)||afterIngredients.has(undefined)||beforeIngredients.size!==before.ingredients.length||afterIngredients.size!==after.ingredients.length)throw Error('MALFORMED');
 for(const child of [...new Set([...beforeIngredients.keys(),...afterIngredients.keys()])].sort()) {
  const a=beforeIngredients.get(child),b=afterIngredients.get(child),effect=doc.getMap(named('recipe-ingredient-index',id)).get(child);
  if(!a&&b){if(effect)throw Error('CONFLICT');add('recipe-ingredient-add',{recipeId:id,ingredientId:child,name:b.name,amount:b.amount??'',needsShopping:b.needsShopping??false,position:b.position,author,at},[root]);continue;}
  if(!effect)throw Error('CONFLICT');const current=doc.getMap(member('recipe-ingredient',id,child)).toJSON();
  if(!b){for(const field of ['name','amount','needsShopping','position']){const fallback=field==='amount'?'':field==='needsShopping'?false:undefined;if(!equal(a[field]??fallback,current[field]??fallback))throw Error('REBASE_REQUIRED');}const prev=doc.getMap(head('ingredient',JSON.stringify([id,child]),'removed')).get('effect');add('recipe-ingredient-field',{recipeId:id,ingredientId:child,field:'removed',value:true,author,at},[root,effect,...(prev?[prev]:[])]);continue;}
  for(const field of ['name','amount','needsShopping','position']) {const av=a[field]??(field==='amount'?'':field==='needsShopping'?false:undefined),bv=b[field]??(field==='amount'?'':field==='needsShopping'?false:undefined),cv=current[field]??(field==='amount'?'':field==='needsShopping'?false:undefined);if(!equal(av,bv)){if(!equal(av,cv))throw Error('REBASE_REQUIRED');const prev=doc.getMap(head('ingredient',JSON.stringify([id,child]),field)).get('effect');add('recipe-ingredient-field',{recipeId:id,ingredientId:child,field,value:bv,author,at},[root,effect,...(prev?[prev]:[])]);}}
 }
 if(!Array.isArray(before.stepIds)||!Array.isArray(after.stepIds)||before.steps.length!==before.stepIds.length||after.steps.length!==after.stepIds.length)throw Error('MALFORMED');
 const steps=(r)=>new Map(r.stepIds.map((id,i)=>[id,{text:r.steps[i],position:i}])),old=steps(before),next=steps(after);
 if(old.size!==before.steps.length||next.size!==after.steps.length)throw Error('MALFORMED');
 for(const child of [...new Set([...old.keys(),...next.keys()])].sort()) {
  const a=old.get(child),b=next.get(child),effect=doc.getMap(named('recipe-step-index',id)).get(child);
  if(!a&&b){if(effect)throw Error('CONFLICT');add('recipe-step-add',{recipeId:id,stepId:child,...b,author,at},[root]);continue;}
  if(!effect)throw Error('CONFLICT');const current=doc.getMap(member('recipe-step',id,child)).toJSON();
  if(!b){if(a.text!==current.text||a.position!==current.position)throw Error('REBASE_REQUIRED');const prev=doc.getMap(head('step',JSON.stringify([id,child]),'removed')).get('effect');add('recipe-step-field',{recipeId:id,stepId:child,field:'removed',value:true,author,at},[root,effect,...(prev?[prev]:[])]);continue;}
  for(const field of ['text','position'])if(a[field]!==b[field]){if(current[field]!==a[field])throw Error('REBASE_REQUIRED');const prev=doc.getMap(head('step',JSON.stringify([id,child]),field)).get('effect');add('recipe-step-field',{recipeId:id,stepId:child,field,value:b[field],author,at},[root,effect,...(prev?[prev]:[])]);}
 }
 return commands;
}
