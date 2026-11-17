// Actual app contracts in an isolated native fixture. This does not drive the app UI.
import {openLocalWorkspace} from './compat-root/app/bootstrap';
import {open} from '@op-engineering/op-sqlite';
import {File,Paths} from 'expo-file-system';
import {writeEncryptedObject,readEncryptedObject} from './compat-root/native/file-transfer';
import {LoroDoc} from './compat-root/native/loro';
import sodium from './compat-root/native/sodium';
import {executeAction} from './compat-root/app/action.mjs';
import {planRecipeAction} from './compat-root/app/recipe-actions.mjs';
import {planShoppingAction} from './compat-root/app/shopping-actions.mjs';
import {projectCooking} from './compat-root/domain/app-projection.mjs';
import {projectCurrentSeed,verifyCurrentSeed} from './compat-root/compromise/current-seed.mjs';
import {prepareInitialPolicy,acceptInitialPolicy} from './compat-root/disclosure/setup.mjs';
import {emptyShoppingState,createShoppingList,appendShoppingItems,setShoppingItemChecked,applyShoppingPurchase} from './compat-app-domain/shopping.ts';
const check=(v,m)=>{if(!v)throw Error(m)};
async function fileProof(w){const objects=(await w.household.storage.listOutboundObjects(w.household.scope.scopeId)).value;check(objects.length>0,'missing outbound');const source=objects[0],object={id:source.objectId,bytes:source.bytes},auth=await w.household.authorization(),verify=async bytes=>(await w.household.codec.openContent(bytes,auth.signingKeyRefs)).object;const file=new File(Paths.cache,'native-loro-proof.json');if(file.exists)file.delete();try{writeEncryptedObject(file,object);const read=await readEncryptedObject(file,verify);check(read.id===object.id,'file read');file.delete();writeEncryptedObject(file,{...object,id:'wrong'});let rejected=false;try{await readEncryptedObject(file,verify)}catch{rejected=true}check(rejected,'file forgery');}finally{if(file.exists)file.delete()}}
async function missingStateChecks(){
 for(const kind of ['sequence','authority','stage','reservation']){const name='proof-missing-'+kind;let workspace;try{workspace=await openLocalWorkspace(name,true)}catch(e){const expected=kind==='sequence'?'MISSING_SEQUENCES':kind==='authority'?'MISSING_AUTHORITY':'LOCKED';if(!String(e).includes(expected))throw e;continue;}
  const scope=workspace.household.scope.scopeId;workspace.close();const db=open({name:`loro-native-${name}.sqlite`});try{if(kind==='sequence')db.executeSync('DELETE FROM loro_sequence_counters');else if(kind==='stage')db.executeSync("UPDATE loro_bootstrap SET stage='sealed' WHERE id=1");else if(kind==='reservation')db.executeSync('UPDATE loro_bootstrap SET stage=?,data=? WHERE id=1',['reserved',new TextEncoder().encode(JSON.stringify({version:1,device:'a',adult:'b',house:'c',personal:'d',houseDoc:'e',personalDoc:'f',houseEpoch:'g',personalEpoch:'h'}))]);else db.executeSync('DELETE FROM loro_records WHERE key=?',[JSON.stringify(['pairing-authority','household',scope])]);}finally{db.close()}
  let rejected=false;try{const invalid=await openLocalWorkspace(name,true);invalid.close()}catch(e){rejected=String(e).includes(kind==='sequence'?'MISSING_SEQUENCES':kind==='authority'?'MISSING_AUTHORITY':'LOCKED')}check(rejected,'missing established '+kind);
 }
}
export async function workspaceProof(){
 if(!global.HermesInternal)throw Error('Hermes required');const scalar=sodium.from_hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');check(sodium.to_hex(sodium.crypto_scalarmult_base(scalar))==='8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a','RFC7748 X25519');scalar.fill(0);await missingStateChecks();const w=await openLocalWorkspace('workspace-proof',true);
 try{
  const prior=(await w.personal.document()).doc.getMap('personal-preferences').get('systemPrompt');
  if(prior==='native proof complete'){const state=projectCooking((await w.household.document()).doc);check(state.shopping.purchases.some(x=>x.id==='purchase')&&state.pantry.some(x=>x.name==='Carrot'),'reopen purchase');check(state.recipes.some(x=>x.id==='recipe'&&x.title==='Rich stew'),'reopen recipe');await w.disclosure.active();await fileProof(w);return 'PASS missing state rejected; native bootstrap and persisted recipe, shopping, pantry, policy and authenticated file reopened';}
  if(w.needsDisclosureSetup){const policy=await prepareInitialPolicy({service:w.disclosure});await acceptInitialPolicy({service:w.disclosure,provider:w.disclosureProvider,deviceId:w.deviceId,policy,explicit:true})}
  const at='2026-01-01T00:00:00.000Z',author=w.deviceId;
  const old={version:1,kind:'pantry-create',commandId:'legacy',effectId:'legacy',dependencyEffectIds:[],data:{itemId:'legacy-pantry',name:'Old pantry',preference:3,at,author}};
  await w.household.execute({operationId:'legacy',deviceSequence:await w.sequences.reserve(w.household.scope.scopeId,'legacy-sequence'),command:old});
  const edit={version:1,kind:'pantry-field',commandId:'incomplete',effectId:'incomplete',dependencyEffectIds:['legacy'],data:{itemId:'legacy-pantry',field:'name',value:'Edited pantry',at,author}};
  await executeAction(w.household,w.sequences,'incomplete-action',[edit],w.disclosure);
  const lineage=await w.household.storage.readDisclosureSource(w.household.scope.scopeId,'incomplete');check(lineage.ok&&lineage.value?.incomplete===true,'incomplete lineage');
  const recipe={id:'recipe',title:'Soup',portions:1,ingredients:[{id:'ingredient',name:'Carrot'}],steps:['Chop'],stepIds:['step'],createdAt:at,updatedAt:at};
  let doc=(await w.household.document()).doc;let commands=planRecipeAction({doc,before:null,after:recipe,actionId:'recipe-action',author,at});await executeAction(w.household,w.sequences,'recipe-action',commands,w.disclosure);
  doc=(await w.household.document()).doc;const beforeRecipe=projectCooking(doc).recipes.find(x=>x.id==='recipe');check(!!beforeRecipe,'created recipe');const afterRecipe={...beforeRecipe,title:'Rich stew',ingredients:beforeRecipe.ingredients.map(x=>({...x,amount:'3 kg'})),steps:['Chop finely']};commands=planRecipeAction({doc,before:beforeRecipe,after:afterRecipe,actionId:'recipe-edit',author,at});await executeAction(w.household,w.sequences,'recipe-edit',commands,w.disclosure);
  let shopping=emptyShoppingState(),pantry=[];const save=async(next,nextPantry=pantry,actionId)=>{doc=(await w.household.document()).doc;const c=planShoppingAction({doc,before:shopping,after:next,pantryBefore:pantry,pantryAfter:nextPantry,actionId,author,at});await executeAction(w.household,w.sequences,actionId,c,w.disclosure);shopping=next;pantry=nextPantry};
  await save(createShoppingList(shopping,{id:'list',cycleId:'cycle',name:'Market',at}),pantry,'list-action');
  await save(appendShoppingItems(shopping,'list',[{id:'item',name:'Carrot',recipeId:'recipe',ingredientId:'ingredient',displayQuantity:'2',displayUnit:'kg',at}]),pantry,'item-action');
  await save(setShoppingItemChecked(shopping,'item','cycle',true,at),pantry,'check-action');
  const purchase=applyShoppingPurchase(shopping,pantry,{id:'purchase',listId:'list',purchaseCycleId:'cycle',purchasedAt:at});await save(purchase.shopping,purchase.pantry,'purchase-action');
  doc=(await w.household.document()).doc;const result=projectCooking(doc);check(result.shopping.purchases.some(x=>x.id==='purchase')&&result.pantry.some(x=>x.name==='Carrot'),'purchase+pantry');
  await fileProof(w);
  const source=doc.export({mode:'snapshot'}),seed=projectCurrentSeed({LoroDoc,source,seedId:'test-seed',peerId:'99',schemaVersion:4});verifyCurrentSeed({LoroDoc,snapshot:seed.snapshot,seed,schemaVersion:4});const seeded=new LoroDoc();seeded.import(seed.snapshot);check(projectCooking(seeded).shopping.purchases.some(x=>x.id==='purchase'),'v4 seed');
  const c={version:1,kind:'personal-preference-put',commandId:'complete',effectId:'complete',dependencyEffectIds:[],data:{key:'systemPrompt',value:'native proof complete'}};await executeAction(w.personal,w.sequences,'complete',[c]);
  return 'PASS missing state rejected; native bootstrap, selected authority, policy, incomplete lineage, rich recipe, v4 shopping purchase+pantry, seed, authenticated file roundtrip and personal action';
 }finally{w.close()}
}
