import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync,
  openSync, closeSync, fsyncSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import * as E from './engines.mjs';
import { SHA, canonical, docId, validateDocument, projectView } from './schema.mjs';

const hash = (data) => SHA(data);
const canonicalBytes = (x) => Buffer.from(JSON.stringify(canonical(x)));
const safeName = (s) => /^[a-zA-Z0-9_.:-]{1,160}$/.test(s);
const strictObject = (obj,keys)=>{
  assert.ok(obj && typeof obj==='object'&&!Array.isArray(obj));
  for(const key of Object.keys(obj))assert.ok(keys.includes(key),'unknown envelope field: '+key);
};
function ensureDir(d){mkdirSync(d,{recursive:true});}
function durableWrite(file,data){
  ensureDir(path.dirname(file));
  const tmp=file+'.next', fd=openSync(tmp,'w',0o600);
  try { const payload=Buffer.isBuffer(data)?data:Buffer.from(data);
    let offset=0;while(offset<payload.length)offset+=writeFileSyncChunk(fd,payload,offset);
    fsyncSync(fd);
  }finally {closeSync(fd);}
  renameSync(tmp,file);
  const dirfd=openSync(path.dirname(file),'r');
  try{fsyncSync(dirfd);}finally{closeSync(dirfd);}
}
function writeFileSyncChunk(fd,buf,offset) {
  // Node's fs.writeSync is intentionally required for short-write handling.
  return writeSyncImpl(fd,buf,offset);
}
import { writeSync as writeSyncImpl } from 'node:fs';
function storedJson(file,value) {
  const payload={...value,integritySha256:hash(canonicalBytes(value))};
  durableWrite(file,JSON.stringify(payload,null,2)+'\n');
}
function readStoredJson(file) {
  const {integritySha256,...payload}=JSON.parse(readFileSync(file,'utf8'));
  assert.equal(integritySha256,hash(canonicalBytes(payload)),'metadata checksum mismatch: '+path.basename(file));
  return payload;
}
export function makeEnvelope(engine,space,bytes,dependencies=[]) {
  assert.ok(ENGINE_NAMES.includes(engine),'unsupported engine');
  assert.ok(bytes instanceof Uint8Array && bytes.length>0,'empty real engine binary');
  const id='update:'+SHA(Buffer.from(bytes));
  return { protocolVersion:1,engine,space,documentId:docId(space),
    schemaVersion:2,id,dependencies:[...dependencies],byteLength:bytes.length,
    payloadSha256:SHA(Buffer.from(bytes)),payload:Uint8Array.from(bytes) };
}
const ENGINE_NAMES=['automerge','loro'];
export function verifyEnvelope(envelope,engine,space) {
  strictObject(envelope,['protocolVersion','engine','space','documentId','schemaVersion','id','dependencies','byteLength','payloadSha256','payload']);
  assert.equal(envelope.protocolVersion,1,'unsupported wire protocol');
  assert.equal(envelope.schemaVersion,2,'unsupported wire schema');
  assert.equal(envelope.engine,engine,'wrong engine');
  assert.deepEqual(envelope.space,space,'wrong-space replay');
  assert.equal(envelope.documentId,docId(space),'wrong document');
  assert.ok(Array.isArray(envelope.dependencies),'bad dependencies');
  assert.ok(envelope.dependencies.every(x=>typeof x==='string'&&safeName(x)),'invalid dependency');
  assert.ok(envelope.payload instanceof Uint8Array && envelope.payload.byteLength>0);
  assert.equal(envelope.byteLength,envelope.payload.byteLength);
  assert.equal(envelope.payloadSha256,SHA(Buffer.from(envelope.payload)),'tampered update payload');
  assert.equal(envelope.id,'update:'+envelope.payloadSha256,'update identity mismatch');
  return true;
}
function encodeWal(envelope) {
  const {payload,...header}=envelope;
  const head=canonicalBytes(header);
  const result=Buffer.allocUnsafe(4+head.length+payload.length);
  result.writeUInt32BE(head.length,0);
  head.copy(result,4);Buffer.from(payload).copy(result,4+head.length);
  return result;
}
function decodeWal(raw) {
  assert.ok(raw.length>4,'truncated WAL header');
  const length=raw.readUInt32BE(0);
  assert.ok(length>0&&length<=65536&&4+length<raw.length,'bad WAL header length');
  const header=JSON.parse(raw.subarray(4,4+length).toString());
  strictObject(header,['protocolVersion','engine','space','documentId','schemaVersion','id','dependencies','byteLength','payloadSha256']);
  return {...header,payload:Uint8Array.from(raw.subarray(4+length))};
}
export class DiskStore {
  constructor(dir,engine,space) {
    assert.ok(ENGINE_NAMES.includes(engine));assert.equal(docId(space).length>0,true);
    this.dir=dir;this.engine=engine;this.space=space;
    ensureDir(dir);
  }
  file(x){return path.join(this.dir,x);}
  manifest(){return existsSync(this.file('manifest.json'))?readStoredJson(this.file('manifest.json')):null;}
  startMigration(doc,{interrupt=false,keyMetadata=null}={}){
    validateDocument(doc,this.space);
    assert.equal(doc.documentId,docId(this.space));
    assert.equal(this.manifest(),null,'cannot overwrite existing active document');
    const binary=E.snapshot(this.engine,E.seed(this.engine,doc));
    const digest=SHA(Buffer.from(binary));
    durableWrite(this.file('snapshots/'+digest+'.bin'),Buffer.from(binary));
    if(interrupt)throw Error('INJECTED:during-migration-before-activation');
    const manifest={format:'creative-cooking-crdt-reference',version:1,
      schemaVersion:2,engine:this.engine,space:this.space,documentId:doc.documentId,
      seedSha256:digest,keyMetadata:keyMetadata ?? {
        keyRequirement:this.space.kind==='household'?'external':'none',
        publicEpochReference:this.space.kind==='household'?'epoch-ref-test-v1':null
      }};
    // Atomic activation occurs LAST, leaving previous state untouched on failure.
    storedJson(this.file('manifest.json'),manifest);
    return {manifest,snapshotBytes:binary.length};
  }
  recover(){
    const manifest=this.manifest();
    if(!manifest)return null;
    strictObject(manifest,['format','version','schemaVersion','engine','space','documentId','seedSha256','keyMetadata']);
    assert.equal(manifest.format,'creative-cooking-crdt-reference');
    assert.equal(manifest.version,1,'unsupported storage version');
    assert.equal(manifest.schemaVersion,2,'incompatible document schema (no downgrade)');
    assert.equal(manifest.engine,this.engine,'storage engine mismatch');
    assert.deepEqual(manifest.space,this.space,'storage space mismatch');
    assert.equal(manifest.documentId,docId(this.space));
    const snapshotFile=this.file('snapshots/'+manifest.seedSha256+'.bin');
    const bytes=readFileSync(snapshotFile);
    assert.equal(SHA(bytes),manifest.seedSha256,'partial or corrupted snapshot');
    let doc=E.load(this.engine,Uint8Array.from(bytes));
    E.read(this.engine,doc,this.space); // validate actual imported engine projection
    const updatesDir=this.file('updates');
    const updates=existsSync(updatesDir)?readdirSync(updatesDir).filter(x=>x.endsWith('.wal')).sort():[];
    const seen=new Set();
    for(const name of updates) {
      const env=decodeWal(readFileSync(path.join(updatesDir,name)));
      verifyEnvelope(env,this.engine,this.space);
      assert.equal(name,env.payloadSha256+'.wal','WAL filename mismatch');
      assert.ok(!seen.has(env.id),'duplicate WAL names');seen.add(env.id);
      doc=E.apply(this.engine,doc,env.payload);
    }
    const result=E.read(this.engine,doc,this.space);
    const checkpoint=this.reviewCheckpoint();
    return {doc,view:projectView(result),document:result,manifest,updates:updates.length,
      checkpoint,frontier:E.frontier(this.engine,doc)};
  }
  reviewCheckpoint(){
    const file=this.file('review-checkpoint.json');
    return existsSync(file)?readStoredJson(file):null;
  }
  receive(env,{crashAt=null,reviewEvents=null}={}){
    verifyEnvelope(env,this.engine,this.space);
    assert.ok(this.manifest(),'must migrate before receiving');
    // Fail closed BEFORE writing an untrusted CRDT binary into the durable WAL.
    // Clone/import only for preflight; no authoritative app document is changed.
    // This is structural admission validation, NOT authenticated transport.
    const preview=E.apply(this.engine,this.recover().doc,env.payload);
    E.read(this.engine,preview,this.space);
    if(crashAt==='before-update-persistence')throw Error('INJECTED:before-update-persistence');
    const wal=this.file('updates/'+env.payloadSha256+'.wal');
    const existed=existsSync(wal);
    if(existed) {
      const prior=decodeWal(readFileSync(wal));
      verifyEnvelope(prior,this.engine,this.space);
      assert.equal(Buffer.compare(Buffer.from(prior.payload),Buffer.from(env.payload)),0);
    } else durableWrite(wal,encodeWal(env));
    if(crashAt==='after-bytes-before-import')throw Error('INJECTED:after-bytes-before-import');
    const recovered=this.recover(); // actual engine import (not simulated merge)
    if(crashAt==='after-import-before-ack')throw Error('INJECTED:after-import-before-ack');
    if(reviewEvents!==null) {
      assert.ok(Array.isArray(reviewEvents),'review events must be array');
      const prior=this.reviewCheckpoint();
      const combined=[...(prior?.events??[])];
      for(const event of reviewEvents) {
        strictObject(event,['id','kind','alternatives','status','engine','entityId','frontier']);
        if(!combined.some(x=>x.id===event.id))combined.push(structuredClone(event));
      }
      storedJson(this.file('review-checkpoint.json'),{
        version:1,engine:this.engine,documentId:docId(this.space),
        sourceFrontier:recovered.frontier,events:combined
      });
    }
    if(crashAt==='after-review-checkpoint')throw Error('INJECTED:after-review-checkpoint');
    // Acknowledgement is deliberately after durable WAL and optional review checkpoint.
    return {acknowledged:true,alreadyPersisted:existed,updates:recovered.updates,
      frontier:recovered.frontier};
  }
  saveFullHistorySnapshot(){
    const recovered=this.recover();
    assert.ok(recovered,'no active document');
    const checkpoint=recovered.checkpoint;
    if(checkpoint?.events.some(x=>x.status==='unresolved')) {
      // This is a NORMAL full history snapshot; never shallow-compacted.
      assert.ok(checkpoint.sourceFrontier.length>0,'unresolved review lacks durable frontier');
    }
    const binary=Buffer.from(E.snapshot(this.engine,recovered.doc));
    const digest=SHA(binary);
    durableWrite(this.file('snapshots/'+digest+'.bin'),binary);
    storedJson(this.file('latest-full-snapshot.json'),{
      version:1,sha256:digest,documentId:docId(this.space),historyRetained:true,
      unresolvedCheckpointed:!!checkpoint?.events.some(x=>x.status==='unresolved')
    });
    return {sha256:digest,bytes:binary.length,historyRetained:true};
  }
  assertNoDestructiveCompaction(){
    const checkpoint=this.reviewCheckpoint();
    if(checkpoint?.events.some(x=>x.status==='unresolved'))
      throw Error('destructive compaction blocked: unresolved review evidence');
    throw Error('destructive compaction not implemented or qualified for this backend');
  }
  exportResearchBundle(){
    const r=this.recover();
    assert.ok(r,'no document to export');
    const binary=Buffer.from(E.snapshot(this.engine,r.doc));
    const updatesDir=this.file('updates');
    const walFiles=existsSync(updatesDir)?readdirSync(updatesDir).filter(x=>x.endsWith('.wal')).sort():[];
    const updates=walFiles.map(name=>readFileSync(path.join(updatesDir,name)).toString('base64'));
    const envelope={
      format:'creative-cooking-research-history',formatVersion:1,schemaVersion:2,
      engine:this.engine,namespace:this.space,documentId:docId(this.space),
      fullSnapshotBase64:binary.toString('base64'),snapshotSha256:SHA(binary),
      updateWalBase64:updates,appView:projectView(r.document),
      reviewCheckpoint:r.checkpoint,keyMetadata:r.manifest.keyMetadata,
      security:'UNAUTHENTICATED_TEST_ONLY_NOT_E2EE'
    };
    // Only a reference/epoch, not a secret key, is permitted in backup metadata.
    strictObject(envelope.keyMetadata,['keyRequirement','publicEpochReference']);
    return envelope;
  }
  static restoreResearchBundle(dir,bundle,{engine,space,hasExternalGroupKey=false,crashBeforeActivation=false}={}){
    strictObject(bundle,['format','formatVersion','schemaVersion','engine','namespace','documentId',
      'fullSnapshotBase64','snapshotSha256','updateWalBase64','appView','reviewCheckpoint','keyMetadata','security']);
    assert.equal(bundle.format,'creative-cooking-research-history');
    assert.equal(bundle.formatVersion,1);
    assert.equal(bundle.schemaVersion,2,'incompatible schema on restore');
    assert.equal(bundle.engine,engine,'restore engine mismatch');
    assert.deepEqual(bundle.namespace,space,'wrong restore space');
    assert.equal(bundle.documentId,docId(space));
    strictObject(bundle.keyMetadata,['keyRequirement','publicEpochReference']);
    if(bundle.keyMetadata.keyRequirement==='external'&&!hasExternalGroupKey)
      throw Error('MISSING_GROUP_KEY: re-pair or obtain separately protected recovery material');
    const raw=Buffer.from(bundle.fullSnapshotBase64,'base64');
    assert.equal(SHA(raw),bundle.snapshotSha256,'corrupted/partial portable snapshot');
    const decoded=E.load(engine,Uint8Array.from(raw));
    const candidate=E.read(engine,decoded,space);
    assert.deepEqual(projectView(candidate),bundle.appView,'tampered app view');
    const instance=new DiskStore(dir,engine,space);
    if(instance.manifest())throw Error('refusing overwrite: restore uses a new target');
    // Use exact imported engine history. No key material from portable bundle.
    const baseDigest=SHA(raw);
    durableWrite(instance.file('snapshots/'+baseDigest+'.bin'),raw);
    for(const item of bundle.updateWalBase64) {
      const record=decodeWal(Buffer.from(item,'base64'));
      verifyEnvelope(record,engine,space);
      durableWrite(instance.file('updates/'+record.payloadSha256+'.wal'),encodeWal(record));
    }
    if(bundle.reviewCheckpoint) {
      strictObject(bundle.reviewCheckpoint,['version','engine','documentId','sourceFrontier','events']);
      assert.equal(bundle.reviewCheckpoint.documentId,docId(space));
      storedJson(instance.file('review-checkpoint.json'),bundle.reviewCheckpoint);
    }
    if(crashBeforeActivation)throw Error('INJECTED:during-restore-before-activation');
    storedJson(instance.file('manifest.json'),{
      format:'creative-cooking-crdt-reference',version:1,schemaVersion:2,
      engine,space,documentId:docId(space),seedSha256:baseDigest,
      keyMetadata:bundle.keyMetadata
    });
    const recovered=instance.recover();
    assert.deepEqual(recovered.view,bundle.appView,'restored view differs from portable bundle');
    return instance;
  }
}
export function inspectDirectory(dir) {
  const files=[];
  function walk(p){
    if(!existsSync(p))return;
    for(const entry of readdirSync(p,{withFileTypes:true})){
      const full=path.join(p,entry.name);
      if(entry.isDirectory())walk(full);
      else if(entry.isFile())files.push({path:path.relative(dir,full),bytes:readFileSync(full)});
    }
  }
  walk(dir);return files;
}
export function dispose(dir){rmSync(dir,{recursive:true,force:true});}
