/**
 * Wire-level adversarial probe against pinned Rust Subduction CLI.
 *
 * Unlike the prior '--auth open' transport proof, these attacks use the REAL
 * '--auth keyhive' server and distinct, handshake-authenticated WASM clients.
 * Intentionally RED if a legacy-ID bypass is exploitable.
 * This does NOT fake an ARK-protected doc or claim a full household E2E pass:
 * the protected-ID control is deliberately *unknown* to the server.
 */
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

const binary = process.env.CC_SUBDUCTION_CLI;
if (!binary) throw new Error("CC_SUBDUCTION_CLI is required");
const root = mkdtempSync(join(tmpdir(), "cc-keyhive-adversarial-"));
const dir = join(root, "storage");
const seed = join(root, "ed25519-seed");
writeFileSync(seed, "bf".repeat(32) + "\n", {mode: 0o600});
const service = "cc-keyhive-attack-local";
let port = 0;
let server: ChildProcess | null = null;
let log = "";
const evidence: Record<string, unknown> = {
  source: "inkandswitch/subduction@f0af1aab5f2fd44e5b224c22fc8b62660d50bc01",
  mode: "keyhive", auth: "per-client WebCryptoSigner Ed25519 handshake",
  runtime: "real pinned Rust CLI / two separate Chromium WASM clients",
  probes: [] as unknown[],
};
const nap = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer().once("error",reject);
    srv.listen(0,"127.0.0.1",()=>{ const a = srv.address(); if(!a || typeof a==="string") throw Error("no port"); srv.close(()=>resolve(a.port)); });
  });
}
async function listen() {
  for(let i=0;i<200;i++){
    try{
      await new Promise<void>((ok,bad)=>{const s=net.connect(port,"127.0.0.1");s.once("connect",()=>{s.destroy();ok()});s.once("error",bad);s.setTimeout(400,()=>{s.destroy();bad(Error("timeout"))});});
      return;
    }catch { if(server?.exitCode!==null) throw Error("CLI exited: "+log.slice(-6000)); await nap(100); }
  }
  throw Error("CLI did not listen: "+log.slice(-6000));
}
async function start() {
  server = spawn(binary!,["server","--socket",`127.0.0.1:${port}`,
    "--service-name",service,"--auth","keyhive","--key-file",seed,"--data-dir",dir],{stdio:["ignore","pipe","pipe"]});
  server.on("error",err=>{log += String(err);});
  server.stdout?.on("data",b=>{log=(log+b.toString()).slice(-80000);});
  server.stderr?.on("data",b=>{log=(log+b.toString()).slice(-80000);});
  await listen();
}
async function stop() {
  if(!server) return;
  const s=server;server=null;
  if(s.exitCode!==null) return;
  await Promise.race([
    new Promise<void>(done=>{s.once("exit",()=>done());s.kill("SIGTERM");}),
    nap(5000).then(()=>{if(s.exitCode===null)s.kill("SIGKILL");})
  ]);
}
async function createPeer(browser:any, sid:Uint8Array){
  const context=await browser.newContext();
  const page=await context.newPage();
  await page.goto("http://127.0.0.1:9891/");
  await page.waitForFunction(()=>(window as any).subductionReady===true,{timeout:30000});
  await page.evaluate(async ({id,url,service})=>{
    const api=(window as any).subduction;
    const signer=await api.WebCryptoSigner.setup();
    const syncer=new api.Subduction({signer,storage:new api.MemoryStorage()});
    const peer=await syncer.connectDiscover(new URL(url),service);
    (window as any).attack={syncer,peer,sid:api.SedimentreeId.fromBytes(new Uint8Array(id))};
  },{id:Array.from(sid),url:`ws://127.0.0.1:${port}`,service});
  return {context,page};
}
async function push(page:any, plaintext:Uint8Array){
  return page.evaluate(async ({blob,head})=>{
    const api=(window as any).subduction;
    const {syncer,peer,sid}=(window as any).attack;
    await syncer.addCommit(sid,new api.CommitId(new Uint8Array(head)),[],new Uint8Array(blob));
    try{
      const result=await syncer.syncWithPeer(peer,sid,true,15000);
      return {threw:false,success:result.success,sent:result.stats.commitsSent,received:result.stats.commitsReceived};
    }catch(error){return{threw:true,error:String(error)};}
  },{blob:Array.from(plaintext),head:Array.from(createHash("sha256").update(plaintext).digest())});
}
async function pull(page:any){
  return page.evaluate(async ()=>{
    const {syncer,peer,sid}=(window as any).attack;
    let outcome:Record<string,unknown>={};
    try{const result=await syncer.syncWithPeer(peer,sid,true,7000);outcome={success:result.success,received:result.stats.commitsReceived};}
    catch(e){outcome={threw:true,error:String(e)};}
    const commits=await syncer.getCommits(sid);
    return{...outcome,commitCount:commits?.length??0};
  });
}
function files(p:string):string[] {
  if(!existsSync(p))return[];
  return readdirSync(p).flatMap(n=>{const f=join(p,n);return statSync(f).isDirectory()?files(f):[f]});
}
function addEvidence(id:string,expected:unknown,observed:unknown,details:Record<string,unknown>={}) {
  const row={id,expected,observed,...details};
  (evidence.probes as unknown[]).push(row);
  console.log("CC_SECURITY_WIRE="+JSON.stringify(row));
}
test.describe.configure({mode:"serial"});
test.beforeAll(async()=>{port=await freePort();await start();});
test.afterAll(async()=>{await stop();rmSync(root,{recursive:true,force:true});});

test("unknown valid protected ID rejects uploads/fetches from unauthorised identities", async({browser},testInfo)=>{
  test.setTimeout(90000);
  const {publicKey}=generateKeyPairSync("ed25519");
  const validProtectedId=new Uint8Array(publicKey.export({format:"der",type:"spki"}).subarray(-32));
  expect(validProtectedId.length).toBe(32);
  expect(validProtectedId.slice(16).some(b=>b!==0)).toBe(true);
  const a=await createPeer(browser,validProtectedId),b=await createPeer(browser,validProtectedId);
  try {
    const upload=await push(a.page,randomBytes(43));
    let result=await pull(b.page);
    for(let i=0;i<12 && result.commitCount===0;i++){await nap(120);result=await pull(b.page);}
    addEvidence("unknown-protected-document",0,result.commitCount,
      {upload,pull:result,idBytes:32,docKnownToServer:false});
    await testInfo.attach("keyhive-protected-unknown-control.json",{body:JSON.stringify(evidence,null,2),contentType:"application/json"});
    expect(result.commitCount,"ungranted protected ID must not be fetchable").toBe(0);
  }finally{await a.context.close();await b.context.close();}
});

test("unauthorised clients must NOT put/fetch legacy zero-padded IDs, including after durable restart",async({browser},testInfo)=>{
  test.setTimeout(100000);
  const legacy=new Uint8Array(32);
  legacy.set(randomBytes(16),0);
  expect(Array.from(legacy.slice(16)).every(b=>b===0)).toBe(true);
  const a=await createPeer(browser,legacy);
  let b:Awaited<ReturnType<typeof createPeer>>|undefined;
  try {
    const marker=randomBytes(57);
    const pushOutcome=await push(a.page,marker);
    await a.page.evaluate(async()=>(window as any).attack.syncer.disconnectAll());
    await a.context.close();
    await stop();
    const persisted=existsSync(join(dir,"sedimentree.redb"));
    await start(); // same keyhive+redb store, key seed and authorization mode
    b=await createPeer(browser,legacy); // entirely different signed Ed25519 identity
    let receiver=await pull(b.page);
    const deadline=Date.now()+6000;
    while(Date.now()<deadline&&receiver.commitCount===0){await nap(200);receiver=await pull(b.page);}
    const storageFiles=files(dir).map(f=>f.replace(root,"<temp>"));
    addEvidence("legacy-zero-padded-id-unauthorized-post-restart",0,receiver.commitCount,
      {pushOutcome,receiver,persisted,metadata:{storageFiles,
        knownDocumentIdLength:32,firstHalfOfIdPublic:true,storageExposesCiphertextSizes:true}});
    await testInfo.attach("keyhive-legacy-adversarial-matrix.json",{
      body:JSON.stringify(evidence,null,2),contentType:"application/json"});
    // This MUST FAIL on vulnerable upstream. Never turn --auth open or mark
    // this check continue-on-error to make a security success out of a bypass.
    expect(receiver.commitCount,
      "SECURITY FAIL: ungranted legacy ID accepted across Keyhive-authenticated server restart").toBe(0);
  }finally{
    if(b)await b.context.close();
    try{await a.context.close();}catch{}
  }
});
