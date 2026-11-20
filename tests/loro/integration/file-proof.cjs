// Run against a local server serving the bundled browser-client as /bundle.js.
const {chromium}=require('@playwright/test');
const path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
 const scratch=process.env.LORO_SCRATCH, cdp=process.env.LORO_CDP, origin=process.env.LORO_ORIGIN;
 if(!scratch||!cdp||!origin)throw Error('LORO_SCRATCH, LORO_CDP and LORO_ORIGIN required');
 const browser=await chromium.connectOverCDP(cdp),contexts=await Promise.all([browser.newContext({acceptDownloads:true}),browser.newContext({acceptDownloads:true})]);
 try{
  const pages=await Promise.all(contexts.map(c=>c.newPage()));
  for(const [i,p] of pages.entries()){p.on('pageerror',e=>console.error(`page ${i}:`,e));p.on('console',m=>{if(m.type()==='error')console.error(`console ${i}:`,m.text())});await p.goto(`${origin}/file.html?device=${i?'b':'a'}`);await p.waitForFunction(()=>!!window.integration);}
  const command={version:1,kind:'recipe-create',commandId:'file-command',effectId:'file-effect',dependencyEffectIds:[],data:{recipe:{id:'file-recipe',title:'Disk soup',portions:1,ingredients:[],steps:[],stepIds:[]},author:'a',at:'2026-01-01T00:00:00Z'}};
  await pages[0].evaluate(c=>window.integration.execute('file-operation',c,1),command);
  const objects=await pages[0].evaluate(()=>window.integration.objects());const id=objects[0].objectId;
  const [download]=await Promise.all([pages[0].waitForEvent('download'),pages[0].evaluate(id=>window.integration.downloadObject(id),id)]);
  const file=path.join(scratch,'runtime-object.bundle');await download.saveAs(file);
  await pages[1].locator('#object-file').setInputFiles(file);await pages[1].waitForFunction(()=>window.fileResult);
  const outcome=await pages[1].evaluate(()=>window.fileResult);assert.deepEqual(outcome,{ok:true,id,replayed:true});
  const first=await pages[0].evaluate(()=>window.integration.read()),second=await pages[1].evaluate(()=>window.integration.read());assert.deepEqual(second,first);assert.equal(second['recipe:file-recipe'].title,'Disk soup');
  await pages[1].evaluate(()=>window.integration.reopen());assert.deepEqual(await pages[1].evaluate(()=>window.integration.read()),first);
  console.log(JSON.stringify({downloaded:file,id,replayed:true,reopened:true,title:second['recipe:file-recipe'].title,browser:browser.version()}));
  await Promise.all(pages.map(p=>p.evaluate(()=>window.integration.cleanup())));
 }finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
