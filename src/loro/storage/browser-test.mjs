// Start an isolated Chromium with a CDP port; set S2_CDP and S2_SCRATCH to run.
import { chromium } from 'playwright';
import ts from 'typescript';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const scratch=process.env.S2_SCRATCH, endpoint=process.env.S2_CDP;
if (!scratch || !endpoint) throw Error('Set S2_SCRATCH and S2_CDP to an isolated scratch directory and browser CDP endpoint');
const root=await mkdtemp(join(scratch,'s2-browser-'));let server,browser;
try {
 for (const dir of ['storage','contracts']) await mkdir(join(root,dir));
 for (const name of ['storage/core','storage/indexeddb','storage/local-keys','storage/recipient','storage/browser-master','contracts/index','contracts/pairing','contracts/runtime-storage','contracts/fixtures']) {const src=await readFile(resolve('src/loro',name+'.ts'),'utf8');const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replaceAll(".ts'",".js'").replaceAll('.ts"','.js"');await writeFile(join(root,name+'.js'),js);}
 await writeFile(join(root,'storage/browser-cases.mjs'),await readFile('src/loro/storage/browser-cases.mjs'));
 await writeFile(join(root,'storage/browser-provisioning.mjs'),await readFile('src/loro/storage/browser-provisioning.mjs'));
 server=createServer(async(req,res)=>{try {const path=new URL(req.url,'http://localhost').pathname;res.setHeader('content-type','text/javascript');res.end(await readFile(join(root,path==='/'?'index.html':path)));}catch{res.statusCode=404;res.end('not found')}});await writeFile(join(root,'index.html'),'<!doctype html><title>S2 storage tests</title>');await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;browser=await chromium.connectOverCDP(endpoint);const context=browser.contexts()[0];const a=await context.newPage(),b=await context.newPage();await Promise.all([a.goto(origin),b.goto(origin)]);
 console.log(await a.evaluate(async()=> (await import('/storage/browser-cases.mjs')).run()));
 console.log(await a.evaluate(async()=> (await import('/storage/browser-provisioning.mjs')).run()));
 const name='s2-tabs-'+crypto.randomUUID();
 await Promise.all([a,b].map(p=>p.evaluate(async name=>{const {openIndexedDBStorage}=await import('/storage/indexeddb.js');window.db=await openIndexedDBStorage(name);window.make=(scope,id,doc)=>({expectedAuthority:{version:2,scope:{kind:'personal',id:scope},record:null},scopeId:scope,operationId:id,documents:[{documentId:doc,bytes:new Uint8Array([1]),expectedRevision:null}],commands:[{version:1,commandId:id,effectId:id,documentId:doc,kind:'x',payload:new Uint8Array([1]),dependencyEffectIds:[]}],outbound:[]});},name)));
 const race=await Promise.all([a,b].map((p,i)=>p.evaluate(i=>window.db.storage.commitLocalGroup({groupId:'g'+i,children:[window.make('personal','p'+i,'chef'+i),window.make('household','h'+i,'shared')]}),i)));assert.equal(race.filter(x=>x.ok).length,1);const loser=race.findIndex(x=>!x.ok);assert.equal(race[loser].error.code,'CONFLICT');assert.equal((await [a,b][loser].evaluate(i=>window.db.storage.reopenDocument('personal','chef'+i),loser)).value,null);
 await Promise.all([a,b].map(p=>p.evaluate(()=>window.db.close())));await a.evaluate(name=>new Promise((resolve,reject)=>{const q=indexedDB.deleteDatabase(name);q.onsuccess=resolve;q.onerror=()=>reject(q.error)}),name);console.log('separate-tab group exclusion passed');
 const quotaOrigin=origin.replace('127.0.0.1','localhost');await a.goto(quotaOrigin);const cdp=await context.newCDPSession(a);await cdp.send('Storage.overrideQuotaForOrigin',{origin:quotaOrigin,quotaSize:1});try {const q=await a.evaluate(async()=>{const {openIndexedDBStorage}=await import('/storage/indexeddb.js');const name='s2-quota-'+crypto.randomUUID();const db=await openIndexedDBStorage(name);const c={expectedAuthority:{version:2,scope:{kind:'personal',id:'s'},record:null},scopeId:'s',operationId:'o',documents:[{documentId:'d',bytes:new Uint8Array(1024),expectedRevision:null}],commands:[{version:1,commandId:'c',effectId:'e',documentId:'d',kind:'x',payload:new Uint8Array([1]),dependencyEffectIds:[]}],outbound:[]};const result=await db.storage.commitLocal(c),doc=await db.storage.reopenDocument('s','d');db.close();await new Promise((resolve,reject)=>{const q=indexedDB.deleteDatabase(name);q.onsuccess=resolve;q.onerror=()=>reject(q.error)});return {result,doc}});assert.equal(q.result.error.code,'CAPACITY');assert.equal(q.doc.value,null);console.log('quota rollback passed');} finally {await cdp.send('Storage.overrideQuotaForOrigin',{origin:quotaOrigin});}
 await a.close();await b.close();
} finally {if(browser) await browser.close();if(server) await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
