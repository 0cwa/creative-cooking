/**
 * Actual, signed p2panda Spaces control+encrypted-app CBOR bytes through
 * real p2panda Node A -> keyless persisted process C -> SIGKILL A/C ->
 * restart C -> late B. Verify with a *separate* Rust TestPeer Bob process:
 * canonical signed header, authenticated Space welcome and Bob decrypt.
 * Repeat native C restart and late E to test uninterrupted original A death.
 *
 * NO production client identity, ACL/revocation policy, network topology,
 * public relay, accountless session, or native iOS/Android runtime proof.
 */
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';

const peerBin=resolve(process.argv[2]||'experiments/p2panda/rust/target/debug/peer');
const spacesBin=resolve(process.argv[3]||'experiments/p2panda/rust/target/debug/examples/spaces_wire');
const output=resolve(process.env.CC_SPACES_EVIDENCE||'experiments/p2panda/artifacts/spaces-native-persistent-catchup.json');
const root=mkdtempSync(join(tmpdir(),'cc-p2panda-spaces-persist-'));
const running=new Set();
const topic=randomBytes(32).toString('hex');
const observations={schemaVersion:1,status:'FAIL',date:new Date().toISOString(),
  versions:{p2panda:'0.7.1',spaces:'0.7.1',iroh:'1.0.3'},
  actualTransport:'p2panda signed native p2panda Node; Iroh same-Linux-host mDNS',
  innerAuth:'genuine p2panda Spaces signed canonical CBOR operation header',
  crypto:'real p2panda Spaces group message ciphertext (NOT fixture AES-GCM)',
  storage:'actual p2panda stream SQLite at native C (keyless for Spaces)',
  assumptions:'all Spaces identities are disposable TestPeer 41/42; Bob test identity recovered by deterministic fixture setup out of band',
  topology:'single Linux CI host: never claim 2 physical hosts, NAT, self-hosted public relay or Expo',
  events:[],nativeHeaders:[]};
const trace=(kind,meta={})=>observations.events.push({at:new Date().toISOString(),kind,...meta});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const sha=b=>createHash('sha256').update(b).digest('hex');
const frameBuf=h=>Buffer.from(h,'hex');
let fixture=null;
function start(label,seed,store) {
 const p=spawn(peerBin,[topic,join(root,store+'.sqlite'),
   seed.toString(16).padStart(2,'0').repeat(32)],{stdio:['pipe','pipe','pipe']});
 running.add(p);
 const x={label,p,lines:[],bytes:[],stderr:''};
 let partial='';
 p.stdout.setEncoding('utf8');
 p.stderr.setEncoding('utf8');p.stderr.on('data',v=>{x.stderr=(x.stderr+v).slice(-6000)});
 p.on('error',err=>{x.stderr+=String(err)});
 p.stdout.on('data',v=>{
   partial+=v;
   let end;
   while((end=partial.indexOf('\n'))>=0) {
     const line=partial.slice(0,end).trim();partial=partial.slice(end+1);
     x.lines.push(line); if(x.lines.length>300)x.lines.shift();
     const event=/received from=(\S+) doc=test\/native-peer bytes=\[([0-9, ]*)\]/.exec(line);
     if(event) {
       const b=Buffer.from(event[2]?event[2].split(',').map(y=>Number(y.trim())):[]);
       x.bytes.push(b);
       trace('native_received',{peer:label,sha256:sha(b),byteLength:b.length,authorId:event[1]});
     }
     if(line.startsWith('sync_')) trace('native_sync',{peer:label,event:line.slice(0,260)});
   }
 });
 trace('start',{peer:label,pid:p.pid,sqlite:store+'.sqlite'});
 return x;
}
async function ready(x,seconds=75) {
 const end=Date.now()+seconds*1000;
 while(Date.now()<end) {
   if(x.lines.some(y=>y.startsWith('topic=')&&y.includes(' node='))) return;
   if(x.p.exitCode!==null)throw Error(x.label+' exited: '+x.stderr);
   await pause(70);
 }
 throw Error('native peer not ready: '+x.label+' stderr='+x.stderr);
}
async function waitFor(x,h,seconds=90) {
 const target=frameBuf(h),end=Date.now()+seconds*1000;
 while(Date.now()<end) {
   if(x.bytes.some(y=>y.equals(target)))return;
   if(x.p.exitCode!==null) throw Error('peer crashed before signed Spaces frame: '+x.label+': '+x.stderr);
   await pause(85);
 }
 throw Error('time out signed Spaces frame '+sha(target)+' peer='+x.label+
   ' recent='+x.lines.slice(-6).join(' | ')+' stderr='+x.stderr);
}
function publish(x,h) {
 assert.equal(x.p.exitCode,null);
 assert.match(h,/^[0-9a-f]+$/);
 x.p.stdin.write('hex:'+h+'\n');
 trace('publish_signed_spaces_cbor',{peer:x.label,sha256:sha(frameBuf(h)),byteLength:frameBuf(h).length});
}
async function kill(x) {
 if(x.p.exitCode!==null)return;
 const gone=new Promise(r=>x.p.once('exit',r));
 x.p.kill('SIGKILL');await gone;running.delete(x.p);
 trace('SIGKILL',{peer:x.label,pid:x.p.pid});
}
function recoveredHeaders(x,expected) {
 // Signed headers retain identical bytes. Incoming p2panda replay order is
 // not relied on: match by identity before handing causal controls to Bob.
 const unique=new Map(x.bytes.map(b=>[sha(b),b]));
 const result=expected.map(h=>{
   const buf=frameBuf(h);
   const actual=unique.get(sha(buf));
   assert.ok(actual?.equals(buf),'lost or mutated Spaces signed header');
   return actual.toString('hex');
 });
 assert.equal(new Set(result).size,expected.length);
 return result;
}
function verifyBob(x,stage,expected,fixturePath,privateDb) {
 const actual=recoveredHeaders(x,expected);
 const receivedPath=join(root,stage+'.json');
 writeFileSync(receivedPath,JSON.stringify({signedHeadersHex:actual}));
 const stdout=execFileSync(spacesBin,['verify',fixturePath,receivedPath,privateDb],
   {encoding:'utf8',timeout:90000});
 const prefix='SPACES_PERSISTENT_NATIVE_VERIFICATION=';
 const line=stdout.split('\n').find(y=>y.startsWith(prefix));
 assert.ok(line,'No signed Spaces verifier machine-readable evidence: '+stdout);
 const result=JSON.parse(line.slice(prefix.length));
 assert.equal(result.status,'PASS');
 assert.equal(result.spacesDecryptedByAuthorizedBob,true);
 assert.equal(result.outsiderDecrypts,false);
 trace('native_signed_spaces_decrypted',{peer:x.label,stage,replayNoop:result.replayIgnoredByTestOperationStore,
   signedTamperRejected:result.signedHeaderTamperRejected,
   readOnlyCanLocallyEncryptWithoutIngressACL:result.readOnlyCanLocallyEncryptWithoutIngressACL});
 return result;
}
try{
 const fp=join(root,'generated-spaces-fixture.json');
 const privateDb=join(root,'bob-private-initial.sqlite');
 const generation=execFileSync(spacesBin,['generate',fp,privateDb],{encoding:'utf8',timeout:90000});
 assert.match(generation,/SPACES_SIGNED_WIRE_GENERATED=/);
 fixture=JSON.parse(readFileSync(fp,'utf8'));
 assert.equal(fixture.signedMessageCount,3);
 assert.equal(fixture.signedHeadersHex.length,3);
 assert.ok(existsSync(privateDb),'Bob private prekey SQLite required; C never sees it');
 function cloneBobSecrets(name) {
   const dest=join(root,name+'.sqlite');
   copyFileSync(privateDb,dest);
   if(existsSync(privateDb+'-wal'))copyFileSync(privateDb+'-wal',dest+'-wal');
   return dest;
 }
 const bobLateDb=cloneBobSecrets('bob-late-private');
 const bobEvenLaterDb=cloneBobSecrets('bob-even-later-private');
 trace('bob_secret_database_persisted_outside_native_C',{keyCustody:'isolated TestPeer sqlite file; not replicated to C'});
 observations.wire=fixture.signedHeadersHex.map((hex,i)=>({phase:['auth','welcome','application'][i],
   bytes:hex.length/2,sha256:sha(frameBuf(hex))}));
 const a=start('A-origin',51,'A');await ready(a);
 const c=start('C-keyless-persistent',52,'C');await ready(c);
 for(const header of fixture.signedHeadersHex) {
   publish(a,header);await waitFor(c,header);
 }
 trace('C_received_all_three_signed_Spaces_headers',{count:3});
 await pause(350);
 await kill(a);await kill(c);
 trace('origin_dead_before_late_reader',{noSimultaneousOriginAndReader:true});
 const restartedC=start('C-restart-from-SQLite',52,'C');await ready(restartedC);
 const b=start('B-late-fresh-native',53,'B');await ready(b);
 for(const header of fixture.signedHeadersHex)await waitFor(b,header);
 observations.lateBob=verifyBob(b,'B-late',fixture.signedHeadersHex,fp,bobLateDb);
 await kill(b);await kill(restartedC);
 const c2=start('C-second-SQLite-restart',52,'C');await ready(c2);
 const e=start('E-very-late-fresh-native',54,'E');await ready(e);
 for(const header of fixture.signedHeadersHex)await waitFor(e,header);
 observations.lateE=verifyBob(e,'E-second-late',fixture.signedHeadersHex,fp,bobEvenLaterDb);
 const disk=readFileSync(join(root,'C.sqlite'));
 const sentinel=Buffer.from(fixture.plaintextSentinel,'utf8');
 observations.keylessC={sqliteBytes:disk.length,hasCleartextSentinel:disk.includes(sentinel),
   spaceIdentityKeysAvailableToC:false,
   persistedEncryptedSignedHeaderCount:fixture.signedHeadersHex.length};
 assert.equal(observations.keylessC.hasCleartextSentinel,false);
 await kill(e);await kill(c2);
 observations.status='PASS';
}catch(error){
 observations.status='FAIL';observations.error=String(error?.stack||error);process.exitCode=1;
 console.error('SPACES_NATIVE_PERSIST_ERROR='+observations.error);
}finally{
 await Promise.all([...running].map(async p=>{
   if(p.exitCode!==null)return;
   const gone=new Promise(r=>p.once('exit',r));
   p.kill('SIGKILL');await gone;
 }));
 mkdirSync(dirname(output),{recursive:true});
 writeFileSync(output,JSON.stringify(observations,null,2));
 rmSync(root,{recursive:true,force:true});
 console.log('SPACES_NATIVE_PERSISTENT_SUMMARY='+JSON.stringify({status:observations.status,
  scenario:output,bytes:observations.wire?.map(x=>x.bytes),actualSpacesE2EE:observations.status==='PASS'}));
}
