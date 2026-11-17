// Local browser harness server. Open /?device=a&control and /?device=b&control
// in separate owned T3 preview profiles after the server prints its URLs.
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
const bundle=await readFile(process.argv[2]), transcriptPath=process.argv[3], ip=process.env.LORO_TEST_IP;
if(!transcriptPath||!ip)throw Error('supply bundle path, transcript path, and LORO_TEST_IP');
const queues={a:[],b:[]}, results=new Map(), lastId={a:0,b:0}; let stopping=false;
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');res.setHeader('cache-control','no-store');if(url.pathname==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle);}if(url.pathname==='/control'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(stopping?{stop:true}:queues[url.searchParams.get('device')]?.shift()??{}));}if(url.pathname==='/result'){let body='';for await(const c of req)body+=c;const value=JSON.parse(body);results.set(`${value.device}:${value.id}`,value);return res.end('ok');}res.setHeader('content-type','text/html');res.end('<script type="module" src="/bundle.js"></script>');}catch(e){res.statusCode=500;res.end(String(e));}});
await new Promise(r=>server.listen(18802,'127.0.0.1',r));console.log('Open separate T3 profiles: http://127.0.0.1:18802/?device=a&control and http://127.0.0.1:18802/?device=b&control');
async function call(device,method,...args){const id=++lastId[device];queues[device].push({id,method,args});for(let i=0;i<750;i++){const value=results.get(`${device}:${id}`);if(value){results.delete(`${device}:${id}`);if(value.error)throw Error(value.error);return value.result;}await delay(40);}throw Error(`timeout ${device}.${method}`);}
async function connect(){const offer=await call('a','offer',ip),answer=await call('b','answer',offer,ip);await call('a','finish',answer);return Promise.all([call('a','connected'),call('b','connected')]);}
async function receipt(device,state,id){const r=await call(device,'receipt');assert.equal(r.state,state);assert.equal(r.objectId,id);return r;}
try{
 await sodium.ready;
 const channels=await connect();
 assert.equal(await call('a','denial'),true);assert.equal(await call('b','denial'),true);
 await call('a','fault','local');await assert.rejects(call('a','execute','title',{commandId:'title',effectId:'title-effect',kind:'recipe-title',value:'Soup'},1),/IO/);await call('a','fault','');assert.deepEqual(await call('a','read'),{recipe:{},purchases:{}});
 const title={commandId:'title',effectId:'title-effect',kind:'recipe-title',value:'Soup'}, carrot={commandId:'ca',effectId:'ea',kind:'purchase',value:'carrots'}, bean={commandId:'cb',effectId:'eb',kind:'purchase',value:'beans'};
 await call('a','execute','title',title,1);await call('a','execute','pa',carrot,2);await call('b','execute','pb',bean,3);
 const ao=await call('a','objects'),bo=await call('b','objects'),first=ao.find(o=>o.effect==='title-effect').objectId,later=ao.find(o=>o.effect==='ea').objectId,other=bo[0].objectId;
 assert.equal(await call('a','fileRoundtrip',first),true); // codec path only, no disk claim.
 await call('a','send',later,'purchase-a');await call('b','incoming');await receipt('a','stored',later);assert.equal(await call('b','premature',later,'purchase-a'),true);await assert.rejects(call('b','apply',later,'purchase-a'),/MISSING_DEPENDENCY/);
 await call('a','send',first,'title');await call('b','incoming');await receipt('a','stored',first);await call('b','fault','import');await assert.rejects(call('b','apply',first,'title'),/IO/);await call('b','fault','');assert.equal(await call('b','premature',first,'title'),true);
 await call('b','apply',first,'title');await receipt('a','applied',first);await call('b','apply',later,'purchase-a');await receipt('a','applied',later);
 await call('b','send',other,'purchase-b');await call('a','incoming');await receipt('b','stored',other);await call('a','apply',other,'purchase-b');await receipt('b','applied',other);
 // A multi-frame object crosses a reconnect, with reversed and duplicate frames.
 const bulk={commandId:'bulk',effectId:'bulk',kind:'purchase',value:'x'.repeat(10000)};await call('a','execute','bulk',bulk,4);const bulkId=(await call('a','objects')).find(o=>o.effect==='bulk').objectId;
 const count=await call('a','prepare',bulkId,'bulk-transfer');assert.ok(count>1);await call('a','parts','bulk-transfer',[count-1,count-1]);await delay(200);assert.equal((await call('b','pending')).incomplete,1);
 await call('a','close');await call('b','close');await connect();await call('a','parts','bulk-transfer',Array.from({length:count-1},(_,i)=>count-2-i));await call('b','incoming');await receipt('a','stored',bulkId);
 await call('a','parts','bulk-transfer',[0,0]);await delay(300);const pending=await call('b','pending');assert.equal(pending.incomplete,0);assert.equal(pending.received,0);assert.deepEqual(pending.errors,[]);
 await call('b','apply',bulkId,'bulk-transfer');await receipt('a','applied',bulkId);
 const state=await call('a','read');assert.deepEqual(state,await call('b','read'));assert.deepEqual(state,{recipe:{title:'Soup'},purchases:{ea:'carrots',eb:'beans',bulk:bulk.value}});
 await call('a','reopen');await call('b','reopen');assert.deepEqual(await call('a','read'),state);assert.deepEqual(await call('b','read'),state);assert.equal((await call('a','execute','title',title,1)).replayed,true);
 const aStates=await call('a','states'),bStates=await call('b','states');assert.equal(aStates.filter(x=>x.state==='applied').length,3);assert.equal(bStates.filter(x=>x.state==='applied').length,1);
 const environments=await Promise.all([call('a','environment'),call('b','environment')]);
 const sourceHashes={};for(const path of ['tests/loro/integration/browser-client.mjs','tests/loro/integration/scenario.mjs'])sourceHashes[path]=createHash('sha256').update(await readFile(path)).digest('hex');
 const facts={version:1,at:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceHashes,network:'same host, no ICE servers; signed SDP uses host IPv4 substitution for mDNS',environments,clients:2,channels,localFailure:true,importFailure:true,storedAndAppliedReceipts:true,reordered:true,duplicateFrames:true,reconnect:true,reopen:true,exactRetry:true,peerDenial:true,fileCodecOnly:true};
 const transcript=JSON.stringify(facts),signatures=await Promise.all([call('a','signedTranscript',transcript),call('b','signedTranscript',transcript)]);
 for(const s of signatures)assert.ok(sodium.crypto_sign_verify_detached(Uint8Array.from(s.signature),new TextEncoder().encode(transcript),Uint8Array.from(s.publicKey)));
 await Promise.all([call('a','cleanup'),call('b','cleanup')]);
 await writeFile(transcriptPath,JSON.stringify({facts,signatures},null,2)+'\n');console.log('PASS',JSON.stringify(facts));
}catch(e){console.error(e);process.exitCode=1;}finally{stopping=true;await delay(100);await new Promise(r=>server.close(r));}
