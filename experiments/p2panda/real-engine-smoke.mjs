/**
 * Genuine Automerge/Loro binary increments -> browser (or Node fetch) ->
 * localhost HTTP bridge -> native p2panda Node A -> persisted native C ->
 * SIGKILL A/C -> C restart -> late native B -> fresh HTTP browser reader ->
 * conflict verification -> causal resolution -> persisted late native E.
 *
 * Proof is SAME-HOST mDNS only, no production auth, no physical phones,
 * no Spaces E2EE: fixture AES-GCM is explicitly disposable test crypto.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { encodeFrame, decodeFrame } from './contract.mjs';
import { startNativeBridge } from './native-bridge.mjs';
import { verifyRecovered } from './engine-fixtures/fixtures.mjs';

const base=resolve('experiments/p2panda');
const binary=resolve(process.argv[2]||'experiments/p2panda/rust/target/debug/peer');
const fixturePath=join(base,'engine-fixtures','artifacts','fixtures.json');
const resultPath=process.env.CC_P2PANDA_OUTPUT||join(base,'artifacts','native-engine-scenarios.json');
const fixture=JSON.parse(readFileSync(fixturePath,'utf8'));
const evidence={schemaVersion:1,runAt:new Date().toISOString(),
  binary,fixtureSource:'PR #43 genuine Automerge 3.5.0 / Loro 1.16.4 incremental changes',
  transport:'actual p2panda 0.7.1 Node, SQLite, Iroh mDNS, three+ separate OS processes',
  browserMode:process.env.CC_BROWSER==='1'?'real headless Chromium on localhost':'Node HTTP client',
  crypto:'disposable AES-256-GCM fixtures, NOT p2panda Spaces E2EE or ACL',
  topology:'one Linux CI host, not two networks or devices',scenarios:[]};
const root=mkdtempSync(join(tmpdir(),'cc-p2panda-real-engines-'));
const running=new Set(),bridges=new Set(),contexts=new Set();
const hash=b=>createHash('sha256').update(b).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const trace=(scenario,event,details={})=>scenario.events.push({at:new Date().toISOString(),event,...details});
let playwrightBrowser=null;

function startPeer(label,topic,seedN,dbName,scenario) {
  const proc=spawn(binary,[topic,join(root,dbName+'.sqlite'),
    seedN.toString(16).padStart(2,'0').repeat(32)],{stdio:['pipe','pipe','pipe']});
  running.add(proc);
  const peer={label,proc,lines:[],received:[],stderr:'',publish(bytes) {
    if(proc.exitCode!==null||proc.killed)throw new Error(label+' offline');
    if(bytes.length>1024*1024)throw new Error('oversized CLI frame');
    proc.stdin.write('hex:'+Buffer.from(bytes).toString('hex')+'\n');
  }};
  proc.on('error',err=>{peer.stderr+=String(err)});
  proc.stderr.setEncoding('utf8');proc.stderr.on('data',x=>peer.stderr=(peer.stderr+x).slice(-10000));
  let pending='';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data',x=>{
    pending+=x;
    let idx;
    while((idx=pending.indexOf('\n'))>=0) {
      const line=pending.slice(0,idx).trim();pending=pending.slice(idx+1);
      peer.lines.push(line);
      if(peer.lines.length>200)peer.lines.shift();
      const match=/received from=\S+ doc=test\/native-peer bytes=\[([0-9, ]*)\]/.exec(line);
      if(match) {
        const raw=Buffer.from(match[1].length?match[1].split(',').map(s=>Number(s.trim())):[]);
        peer.received.push(raw);
        let framed;
        try{framed=decodeFrame(new Uint8Array(raw));}catch{continue;}
        trace(scenario,'received-native',{peer:label,sha256:hash(framed.bytes),bytes:framed.bytes.length});
      } else if(line.startsWith('sync_')) trace(scenario,'native-sync',{peer:label,detail:line.slice(0,250)});
    }
  });
  trace(scenario,'start-peer',{peer:label,pid:proc.pid,db:dbName});
  return peer;
}
async function ready(peer,timeout=90000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    if(peer.lines.some(x=>x.startsWith('topic=')&&x.includes(' node=')))return;
    if(peer.proc.exitCode!==null)throw new Error(peer.label+' exited: '+peer.stderr);
    await delay(90);
  }
  throw new Error(peer.label+' did not become ready: '+peer.stderr.slice(-2200));
}
async function has(peer,commit,timeout=100000){
  const expected=hash(Buffer.from(commit.ciphertextBase64,'base64'));
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    if(peer.received.some(x=>{try{return hash(decodeFrame(new Uint8Array(x)).bytes)===expected;}catch{return false;}}))return;
    if(peer.proc.exitCode!==null)throw new Error(peer.label+' exited while awaiting '+expected+' '+peer.stderr);
    await delay(120);
  }
  throw new Error(peer.label+' timeout for '+expected+' lines='+peer.lines.slice(-5).join(' | ')+' stderr='+peer.stderr);
}
async function killed(peer,scenario){
  if(peer.proc.exitCode!==null)return;
  const done=new Promise(resolve=>peer.proc.once('exit',resolve));
  peer.proc.kill('SIGKILL');await done;running.delete(peer.proc);
  trace(scenario,'SIGKILL',{peer:peer.label,pid:peer.proc.pid});
}
async function bridgeFor(peer,topic){
  const token=randomBytes(24).toString('hex');
  const handle=await startNativeBridge(peer,topic,token);
  const connected={...handle,token};
  bridges.add(connected);
  return connected;
}
async function stopBridge(bridge){
  if(bridges.has(bridge)){await bridge.close();bridges.delete(bridge);}
}
async function client(bridge){
  if(!playwrightBrowser)return {bridge};
  const ctx=await playwrightBrowser.newContext(),page=await ctx.newPage();
  contexts.add(ctx);await page.goto(bridge.url);
  assert.equal(await page.evaluate(()=>window.isSecureContext),true);
  return {bridge,ctx,page};
}
async function stopClient(c){if(c.ctx){await c.ctx.close();contexts.delete(c.ctx);}}
async function request(c,method,bytes=null){
  const {url,endpoint,token}=c.bridge;
  if(c.page){
    return c.page.evaluate(async({url,endpoint,token,method,data})=>{
      const response=await fetch(url+endpoint,{method,
        headers:{'X-Spike-Token':token,...(data?{'Content-Type':'application/octet-stream'}:{})},
        ...(data?{body:new Uint8Array(data)}:{})});
      return {status:response.status,body:await response.json()};
    },{url,endpoint,token,method,data:bytes?[...bytes]:null});
  }
  const response=await fetch(url+endpoint,{method,headers:{'X-Spike-Token':token},
    ...(bytes?{body:bytes}:{})});
  return {status:response.status,body:await response.json()};
}
async function push(c,scenario,commit){
  const encrypted=Buffer.from(commit.ciphertextBase64,'base64');
  const encoded=encodeFrame({documentId:scenario.spaceId+'/'+scenario.documentId,bytes:new Uint8Array(encrypted)});
  const res=await request(c,'POST',encoded);
  assert.equal(res.status,202,JSON.stringify(res.body));
  assert.equal(res.body.sha256,commit.payloadSha256);
}
async function recovered(c,scenario,n,phase){
  const response=await request(c,'GET');
  assert.equal(response.status,200,JSON.stringify(response.body));
  const frames=response.body.frames.filter(x=>x.documentId===scenario.spaceId+'/'+scenario.documentId);
  const expected=scenario.commits.slice(0,n);
  const unique=new Map(frames.map(x=>[x.sha256,Buffer.from(x.bytesBase64,'base64')]));
  assert.equal(unique.size,n,'Unexpected native p2panda frame count');
  for(const item of expected)assert.ok(unique.get(item.payloadSha256)?.equals(
    Buffer.from(item.ciphertextBase64,'base64')),'byte mismatch: '+item.kind);
  return verifyRecovered(scenario,[...unique.values()],phase);
}
async function scenarioCase(scenario){
  const output={engine:scenario.engine,spaceId:scenario.spaceId,events:[],plaintextBytes:scenario.commits.map(x=>x.plainByteLength),
    ciphertextBytes:scenario.commits.map(x=>x.byteLength),ciphertextHashes:scenario.commits.map(x=>x.payloadSha256)};
  evidence.scenarios.push(output);
  const topic=randomBytes(32).toString('hex'),prefix=scenario.engine;
  const a=startPeer('A-'+prefix,topic,11,prefix+'-A',output);
  await ready(a);
  const c=startPeer('C-'+prefix,topic,12,prefix+'-C',output);
  await ready(c);
  const bridgeA=await bridgeFor(a,topic),producer=await client(bridgeA);
  for(const item of scenario.commits.slice(0,3)){await push(producer,scenario,item);await has(c,item);}
  trace(output,'C-persisted-conflicting-4-and-6',{count:3});
  await stopClient(producer);await stopBridge(bridgeA);
  await killed(a,output);await killed(c,output);
  const restartedC=startPeer('C-restarted-'+prefix,topic,12,prefix+'-C',output);
  await ready(restartedC);
  const b=startPeer('B-late-'+prefix,topic,13,prefix+'-B',output);
  await ready(b);
  for(const item of scenario.commits.slice(0,3))await has(b,item);
  const bridgeB=await bridgeFor(b,topic),lateReader=await client(bridgeB);
  output.conflict=await recovered(lateReader,scenario,3,'conflict');
  assert.deepEqual(output.conflict.portionsAlternatives,[4,6]);
  // The late device creates a later *causal* resolution update, not the dead A.
  await push(lateReader,scenario,scenario.commits[3]);
  await has(restartedC,scenario.commits[3]);
  output.causalResolution=await recovered(lateReader,scenario,4,'resolved');
  assert.equal(output.causalResolution.portions,5);
  await stopClient(lateReader);await stopBridge(bridgeB);
  await killed(b,output);await killed(restartedC,output);
  const secondRestart=startPeer('C-second-restart-'+prefix,topic,12,prefix+'-C',output);
  await ready(secondRestart);
  const e=startPeer('E-fresh-'+prefix,topic,14,prefix+'-E',output);
  await ready(e);
  for(const item of scenario.commits)await has(e,item);
  const bridgeE=await bridgeFor(e,topic),fresh=await client(bridgeE);
  output.lateRecovery=await recovered(fresh,scenario,4,'resolved');
  await stopClient(fresh);await stopBridge(bridgeE);
  // Rust p2panda SQLite C contains only encrypted *fixture* application bytes.
  const db=readFileSync(join(root,prefix+'-C.sqlite'));
  output.persistentReplica={dbBytes:db.length,containsAnyPlaintextSentinel:
    fixture.plaintextSentinels.some(s=>db.includes(Buffer.from(s)))};
  assert.equal(output.persistentReplica.containsAnyPlaintextSentinel,false);
  await killed(e,output);await killed(secondRestart,output);
  output.status='PASS';
  return output;
}
try {
  if(process.env.CC_BROWSER==='1'){
    const {chromium}=await import('playwright');
    playwrightBrowser=await chromium.launch({headless:true});
  }
  for(const scenario of fixture.scenarios)await scenarioCase(scenario);
  evidence.status='PASS';
}catch(error){
  evidence.status='FAIL';evidence.error=String(error?.stack||error);
  console.error(evidence.error);process.exitCode=1;
}finally{
  for(const c of contexts)await c.close().catch(()=>{});
  for(const bridge of bridges)await bridge.close().catch(()=>{});
  if(playwrightBrowser)await playwrightBrowser.close().catch(()=>{});
  await Promise.all([...running].map(p=>new Promise(resolve=>{
    if(p.exitCode!==null)return resolve();
    p.once('exit',resolve);p.kill('SIGKILL');
  })));
  mkdirSync(dirname(resultPath),{recursive:true});
  writeFileSync(resultPath,JSON.stringify(evidence,null,2));
  rmSync(root,{recursive:true,force:true});
  console.log('CC_P2PANDA_REAL_ENGINE_EVIDENCE='+JSON.stringify({
    status:evidence.status,path:resultPath,engines:evidence.scenarios.map(x=>({engine:x.engine,status:x.status||'FAIL'}))}));
}
