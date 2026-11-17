import {findLocalKey,installLocalKey,validLocalRecord,validMasterCatalog} from './local-keys.ts';
import { pairingReleaseKey, validatePairingAuthority, validPairingScope } from '../contracts/pairing.ts';
import type { ProjectionPublication, ProjectionAtomicStorage } from '../contracts/projection.ts';
import type { RuntimeStorageReader } from '../contracts/runtime-storage.ts';
import type { PairingAtomicStorage, PairingAuthorityRecord, PairingAuthorityWrite, PairingRelease, PairingReleaseResult, PairingScope } from '../contracts/pairing.ts';
import { storageOperationKey, storageGroupKey, validateInboxItem, validateStorageReceipt } from '../contracts/index.ts';
import type { AtomicStorage, CommitResult, GroupCommitResult, LocalCommit, LocalCommitGroup, ImportCommit, InboxItem, OutboxReceipt, StorageError, SavedOutcome, Result } from '../contracts/index.ts';

type Tx = { get(key: string): Promise<any>; put(key: string, value: any): Promise<void>; keys(): Promise<string[]> };
export type TransactionRunner = <T>(write: boolean, body: (tx: Tx) => Promise<T>) => Promise<T>;
const key = (...parts: string[]) => JSON.stringify(parts);
const conflict = (): never => { throw new StorageFailure('CONFLICT'); };
export class StorageFailure extends Error { readonly code: StorageError; constructor(code: StorageError) { super(code); this.code = code; } }
const mapError = (e: unknown): StorageError => e instanceof StorageFailure ? e.code : e instanceof Error && e.message==='LOCKED' ? 'LOCKED' : e instanceof Error && e.message==='CONFLICT' ? 'CONFLICT' : e instanceof Error && (e.name === 'QuotaExceededError' || /SQLITE_FULL|database or disk is full/i.test(e.message)) ? 'CAPACITY' : 'IO';
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const copy = (v: Uint8Array) => new Uint8Array(v);
const snapshot = <T>(v: T): T => (v instanceof Uint8Array ? copy(v) : Array.isArray(v) ? v.map(snapshot) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x]) => [k,snapshot(x)])) : v) as T;
const corrupt = (): never => { throw new StorageFailure('CORRUPT'); };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);
const fields = (v: unknown, names: string[]): v is Record<string, any> => object(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v,k));
export const denseArray = (v: unknown, check: (item: any) => boolean): v is any[] => {
  if (!Array.isArray(v)) return false;
  for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v,i) || !check(v[i])) return false;
  return true;
};
const decodeKeyBytes = (x: unknown): Uint8Array => { if (!denseArray(x,n=>Number.isInteger(n) && n>=0 && n<=255)) return corrupt(); return new Uint8Array(x); };
const revision = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const outcomeShape = (v: unknown): v is SavedOutcome => fields(v,['state','revisions']) && v.state === 'saved' && denseArray(v.revisions, (x: unknown) => fields(x,['documentId','revision']) && typeof x.documentId === 'string' && x.documentId.length > 0 && revision(x.revision)) && v.revisions.length > 0;
const validateRecord = (k: string, v: any) => {
  if (v === undefined) return;
  const namespace = JSON.parse(k)[0];
  let valid = false;
  switch (namespace) {
    case 'local-master-catalog': valid = validMasterCatalog(v) || (fields(v,['version','state','id']) && v.version===1 && v.state==='reserved' && typeof v.id==='string' && !!v.id); break;
    case 'local-key': case 'local-key-operation': valid = validLocalRecord(v); break;
    case 'projection-publication': valid = fields(v,['inputKey','input']) && typeof v.inputKey==='string' && projectionKey(v.input)===v.inputKey; break;
    case 'projection-manifest': case 'projection-package': valid = v instanceof Uint8Array; break;
    case 'projection-outbox': valid = fields(v,['packageId','recipientDevice']) && typeof v.packageId==='string' && typeof v.recipientDevice==='string'; break;
    case 'projection-pending': valid = typeof v==='string'; break;
    case 'projection-document': valid = fields(v,['generation','operationId']) && revision(v.generation) && typeof v.operationId==='string'; break;
    case 'pairing-authority': valid = validatePairingAuthority(v).ok; break;
    case 'pairing-release': { const parsed = fields(v,['inputKey','release']) ? pairingReleaseKey(v.release) : null; valid = !!parsed && parsed.ok && parsed.value === v.inputKey; break; }
    case 'pairing-guard': case 'pairing-packet': case 'pairing-outbox': valid = typeof v === 'string' && v.length > 0; break;
    case 'document-owner': valid = typeof v==='string' && !!v; break;
    case 'document': valid = fields(v,['bytes','revision']) && v.bytes instanceof Uint8Array && revision(v.revision); break;
    case 'object': valid = fields(v,['bytes','branchHead','epochId']) && v.bytes instanceof Uint8Array && typeof v.branchHead === 'string' && !!v.branchHead && typeof v.epochId === 'string' && !!v.epochId; break;
    case 'inbox': valid = fields(v,['bytes']) && v.bytes instanceof Uint8Array; break;
    case 'local': case 'import': valid = fields(v,['inputKey','outcome']) && typeof v.inputKey === 'string' && outcomeShape(v.outcome); break;
    case 'group': valid = fields(v,['inputKey','outcomes']) && typeof v.inputKey === 'string' && denseArray(v.outcomes,outcomeShape) && v.outcomes.length > 0; break;
    case 'receipt-state': valid = v === 'stored' || v === 'applied'; break;
    case 'cursor': case 'command': case 'effect': case 'applied': case 'receipt': valid = typeof v === 'string'; break;
  }
  if (!valid) corrupt();
};
const validateOutcome = (outcome: SavedOutcome, docs: LocalCommit['documents']) => {
  if (outcome.revisions.length !== docs.length || outcome.revisions.some((r,i) => r.documentId !== docs[i].documentId || r.revision !== (docs[i].expectedRevision === null ? 0 : docs[i].expectedRevision! + 1))) corrupt();
};
const fail = (code: StorageError): {ok:false;error:{code:StorageError;recovery:'reload-durable-state'}} => ({ok:false,error:{code,recovery:'reload-durable-state'}});

const validId = (x: unknown): x is string => typeof x==='string' && !!x && new TextEncoder().encode(x).length<=256;
const projectionCanonical = (v: unknown): unknown => v instanceof Uint8Array ? Array.from(v) : Array.isArray(v) ? v.map(projectionCanonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,projectionCanonical(v[k])])) : v;
function projectionKey(x: unknown): string | null {
 if (!(fields(x,['version','operationId','expectedAuthority','nextAuthority','admissionEventHash','grantHash','manifest','epochId','documents','packages','localKey','pendingEdits']) || (fields(x,['version','operationId','guardId','expectedAuthority','nextAuthority','admissionEventHash','grantHash','manifest','epochId','documents','packages','localKey','pendingEdits']) && validId(x.guardId)) || (fields(x,['version','operationId','guardId','sourceDocument','expectedAuthority','nextAuthority','admissionEventHash','grantHash','manifest','epochId','documents','packages','localKey','pendingEdits']) && validId(x.guardId) && fields(x.sourceDocument,['documentId','revision']) && validId(x.sourceDocument.documentId) && revision(x.sourceDocument.revision)) || (fields(x,['version','operationId','guardIds','sourceDocument','expectedAuthority','nextAuthority','admissionEventHash','grantHash','manifest','epochId','documents','packages','localKey','pendingEdits']) && denseArray(x.guardIds,validId) && x.guardIds.length>0 && x.guardIds.length<=128 && x.guardIds.every((v:string,i:number)=>!i || x.guardIds[i-1]<v) && fields(x.sourceDocument,['documentId','revision']) && validId(x.sourceDocument.documentId) && revision(x.sourceDocument.revision))) || x.version!==1 || ![x.operationId,x.admissionEventHash,x.grantHash,x.epochId].every(validId)) return null;
 const a=x.expectedAuthority, n=x.nextAuthority, m=x.manifest;
 if (!fields(x.localKey,['record','catalog']) || !validLocalRecord(x.localKey.record) || !validMasterCatalog(x.localKey.catalog) || x.localKey.record.masterId!==x.localKey.catalog.id || x.localKey.record.identity.purpose!=='data' || x.localKey.record.identity.scope.kind!=='household' || x.localKey.record.identity.scope.id!==a?.scope?.id || x.localKey.record.identity.epochId!==x.epochId) return null;
 if (!fields(a,['version','scope','record']) || a.version!==2 || !validPairingScope(a.scope) || a.scope.kind!=='household' || !fields(a.record,['revision','acceptedParent','authorizationSnapshot']) || !revision(a.record.revision) || a.record.revision>=Number.MAX_SAFE_INTEGER || ![a.record.acceptedParent,a.record.authorizationSnapshot].every(validId) || !validatePairingAuthority(n).ok || n.scope.kind!==a.scope.kind || n.scope.id!==a.scope.id || n.revision!==a.record.revision+1 || !fields(m,['id','bytes']) || !validId(m.id) || !(m.bytes instanceof Uint8Array) || !m.bytes.length) return null;
 if (!denseArray(x.documents,(d:unknown)=>fields(d,['documentId','generation','bytes']) && validId(d.documentId) && revision(d.generation) && d.bytes instanceof Uint8Array && d.bytes.length>0) || !x.documents.length || x.documents.length>16 || !denseArray(x.packages,(p:unknown)=>fields(p,['id','recipientDevice','bytes']) && validId(p.id) && validId(p.recipientDevice) && p.bytes instanceof Uint8Array && p.bytes.length>0) || !x.packages.length || x.packages.length>128 || !denseArray(x.pendingEdits,(p:unknown)=>fields(p,['scopeId','operationId']) && validId(p.scopeId) && validId(p.operationId)) || x.pendingEdits.length>256) return null;
 if (new Set(x.documents.map((d:any)=>d.documentId)).size!==x.documents.length || new Set(x.packages.map((p:any)=>p.id)).size!==x.packages.length || new Set(x.pendingEdits.map((p:any)=>JSON.stringify([p.scopeId,p.operationId]))).size!==x.pendingEdits.length) return null;
 const blobs=[m.bytes,n.authorityState,...x.documents.map((d:any)=>d.bytes),...x.packages.map((p:any)=>p.bytes)];
 if (blobs.some((b:Uint8Array)=>b.length>2_500_000) || blobs.reduce((n:number,b:Uint8Array)=>n+b.length,0)>8_000_000) return null;
 return JSON.stringify(projectionCanonical(x));
}

/** Database transactions, not process locks, provide isolation. */
export class TransactionalStorage implements AtomicStorage, PairingAtomicStorage, RuntimeStorageReader, ProjectionAtomicStorage {
  private readonly run: TransactionRunner;
  private readonly fault?: (boundary: string) => void;
  constructor(run: TransactionRunner, fault?: (boundary: string) => void) { this.fault = fault; this.run = (write, body) => run(write, tx => body({keys: () => tx.keys(), get: async k => { const value = await tx.get(k); validateRecord(k,value); return value; }, put: async (k,v) => { await tx.put(k,v); fault?.('write'); }})); }
  /** Read durable records for runtime queues without exposing mutable stored buffers. */
  async listRecords(namespace: 'document' | 'object' | 'inbox' | 'cursor' | 'receipt-state', scopeId: string): Promise<Result<readonly { identity: readonly string[]; value: unknown }[], StorageError>> {
    try { return await this.run(false, async tx => {
      const records: { identity: string[]; value: unknown }[] = [];
      for (const k of await tx.keys()) {
        let parts: unknown; try { parts = JSON.parse(k); } catch { return corrupt(); }
        if (!denseArray(parts,x => typeof x === 'string')) return corrupt();
        if (parts[0] === namespace && parts[1] === scopeId) records.push({identity: parts.slice(2), value: snapshot(await tx.get(k))});
      }
      return {ok:true,value:records};
    }); } catch (e) { return {ok:false,error:mapError(e)}; }
  }
  async getLocalGroup(groupId: string): Promise<Result<{group: import('../contracts/index.ts').LocalCommitGroup; outcomes: readonly SavedOutcome[]} | null, StorageError>> {
    if (typeof groupId !== 'string' || !groupId || new TextEncoder().encode(groupId).length>256) return {ok:false,error:'MALFORMED'};
    try { return await this.run(false,async tx=>{
      const old=await tx.get(key('group',groupId)); if (!old) return {ok:true,value:null};
      let refs: unknown;
      try { const parsed=JSON.parse(old.inputKey); if (!Array.isArray(parsed) || parsed.length!==2 || parsed[0]!==groupId || !denseArray(parsed[1],x=>typeof x==='string') || !parsed[1].length) return corrupt(); refs=parsed[1]; } catch { return corrupt(); }
      const children: LocalCommit[]=[];
      for (const ref of refs as string[]) {
        let c: LocalCommit;
        try { const p=JSON.parse(ref); if (!Array.isArray(p) || p.length!==2 || p[0]!=='local' || !object(p[1])) return corrupt(); c=p[1] as LocalCommit;
          if (!Object.hasOwn(c,'expectedAuthority')) return {ok:false,error:'UNSUPPORTED_VERSION'};
          for (const d of c.documents) d.bytes=decodeKeyBytes(d.bytes);
          for (const command of c.commands) command.payload=decodeKeyBytes(command.payload);
          for (const entry of c.outbound) entry.object.bytes=decodeKeyBytes(entry.object.bytes);
        } catch(e) { if(e instanceof StorageFailure) throw e; return corrupt(); }
        const checked=storageOperationKey(c,'local'); if (!checked.ok || checked.value!==ref) return corrupt();
        const operation=await tx.get(key('local',c.scopeId,c.operationId)); if (!operation || operation.inputKey!==ref) return corrupt();
        const index=children.length; if (!old.outcomes[index] || JSON.stringify(operation.outcome)!==JSON.stringify(old.outcomes[index])) return corrupt();
        validateOutcome(operation.outcome,c.documents);
        try { await this.completedLocal(tx,c,ref); } catch(e) { if(e instanceof StorageFailure && e.code==='CONFLICT') return corrupt(); throw e; }
        children.push(c);
      }
      const group={groupId,children}, groupKey=storageGroupKey(group);
      if (!groupKey.ok || groupKey.value!==old.inputKey || old.outcomes.length!==children.length) return corrupt();
      return {ok:true,value:{group:snapshot(group),outcomes:snapshot(old.outcomes)}};
    }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  private async localOperation(tx:Tx,scopeId:string,operationId:string):Promise<{commit:LocalCommit;outcome:SavedOutcome}|null> {
    const old=await tx.get(key('local',scopeId,operationId)); if (!old) return null;
    let c: LocalCommit; try { const parsed=JSON.parse(old.inputKey); if (!Array.isArray(parsed) || parsed[0]!=='local' || parsed.length!==2) return corrupt(); c=parsed[1];
      for (const d of c.documents) d.bytes=decodeKeyBytes(d.bytes); for (const cmd of c.commands) cmd.payload=decodeKeyBytes(cmd.payload); for (const o of c.outbound) o.object.bytes=decodeKeyBytes(o.object.bytes);
    } catch { return corrupt(); }
    if (!Object.hasOwn(c,'expectedAuthority')) throw new StorageFailure('UNSUPPORTED_VERSION');
    const checked=storageOperationKey(c,'local'); if (!checked.ok || checked.value!==old.inputKey || c.scopeId!==scopeId || c.operationId!==operationId) return corrupt();
    validateOutcome(old.outcome,c.documents); try { await this.completedLocal(tx,c,old.inputKey); } catch(e) { if(e instanceof StorageFailure && e.code==='CONFLICT') return corrupt(); throw e; }
    return {commit:snapshot(c),outcome:snapshot(old.outcome)};
  }
  async getLocalOperation(scopeId:string,operationId:string):Promise<Result<{commit:LocalCommit;outcome:SavedOutcome}|null,StorageError>> {
    if (![scopeId,operationId].every(validId)) return {ok:false,error:'MALFORMED'};
    try {return await this.run(false,async tx=>({ok:true,value:await this.localOperation(tx,scopeId,operationId)}));} catch(e){return {ok:false,error:mapError(e)};}
  }
  async getInboxApplication(scopeId: string, itemId: string): Promise<Result<{operationId: string; outcome: SavedOutcome} | null, StorageError>> {
    if (![scopeId,itemId].every(x=>typeof x==='string' && !!x && new TextEncoder().encode(x).length<=256)) return {ok:false,error:'MALFORMED'};
    try { return await this.run(false,async tx => { const op=await tx.get(key('applied',scopeId,itemId)); if (op===undefined) return {ok:true,value:null};
      const old=await tx.get(key('import',scopeId,op)); if (!old || await tx.get(key('inbox',scopeId,itemId))===undefined) return corrupt();
      let c: ImportCommit; try { const parsed=JSON.parse(old.inputKey); if (!Array.isArray(parsed) || parsed[0]!=='import' || parsed.length!==2) return corrupt(); c=parsed[1]; for (const d of c.documents) d.bytes=decodeKeyBytes(d.bytes); if (c.version === 2 && Array.isArray(c.commands)) for (const command of c.commands) command.payload=decodeKeyBytes(command.payload); } catch { return corrupt(); }
      if (!Object.hasOwn(c,'expectedAuthority') || c.version !== 2 || !Object.hasOwn(c,'commands')) return {ok:false,error:'UNSUPPORTED_VERSION'}; const checked=storageOperationKey(c,'import'); if (!checked.ok || checked.value!==old.inputKey || c.scopeId!==scopeId || c.itemId!==itemId || c.operationId!==op) return corrupt();
      validateOutcome(old.outcome,c.documents); for (const command of c.commands) if (await tx.get(key('command',scopeId,command.commandId))!==old.inputKey || await tx.get(key('effect',scopeId,command.effectId))!==old.inputKey) return corrupt();
      return {ok:true,value:{operationId:op,outcome:snapshot(old.outcome)}};
    }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  private async typedRecords<T>(namespace: 'document' | 'object' | 'inbox' | 'cursor' | 'receipt-state', scopeId: string, convert: (identity: readonly string[], value: any) => T): Promise<Result<readonly T[],StorageError>> {
    if (typeof scopeId !== 'string' || !scopeId || new TextEncoder().encode(scopeId).length > 256) return {ok:false,error:'MALFORMED'};
    const records=await this.listRecords(namespace,scopeId); if (!records.ok) return records;
    try { return {ok:true,value:records.value.map(r=>convert(r.identity,r.value))}; } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  listDocuments(scopeId: string) { return this.typedRecords('document',scopeId,(i,v) => { if (i.length!==1 || !i[0]) return corrupt(); return {documentId:i[0],bytes:v.bytes as Uint8Array,revision:v.revision as number}; }); }
  listOutboundObjects(scopeId: string) { return this.typedRecords('object',scopeId,(i,v) => { if (i.length!==1 || !i[0]) return corrupt(); return {objectId:i[0],bytes:v.bytes as Uint8Array,branchHead:v.branchHead as string,epochId:v.epochId as string}; }); }
  listStagedInbox(scopeId: string) { return this.typedRecords('inbox',scopeId,(i,v) => { if (i.length!==1 || !i[0]) return corrupt(); return {itemId:i[0],bytes:v.bytes as Uint8Array}; }); }
  listCursors(scopeId: string) { return this.typedRecords('cursor',scopeId,(i,v) => { if (i.length!==1 || !i[0]) return corrupt(); return {source:i[0],cursor:v as string}; }); }
  listReceiptStates(scopeId: string) { return this.typedRecords('receipt-state',scopeId,(i,v) => { if (i.length!==3 || !i[0] || !i[2] || (i[1]!=='relay' && i[1]!=='peer') || (i[1]==='relay' && v==='applied')) return corrupt(); return {objectId:i[0],destination:i[1] as 'relay' | 'peer',recipientId:i[2],state:v as 'stored' | 'applied'}; }); }
  async readPairingAuthority(scope: PairingScope): Promise<Result<PairingAuthorityRecord | null, StorageError>> {
    if (!validPairingScope(scope)) return {ok:false,error:'MALFORMED'};
    scope = snapshot(scope);
    try { return await this.run(false,async tx => { const v = await tx.get(key('pairing-authority',scope.kind,scope.id)); if (v && (v.scope.kind !== scope.kind || v.scope.id !== scope.id)) corrupt(); return {ok:true,value:v ? snapshot(v) : null}; }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  async compareAndSwapPairingAuthority(write: PairingAuthorityWrite): Promise<Result<void, StorageError>> {
    if (!fields(write,['expectedRevision','record']) || !(write.expectedRevision === null || (revision(write.expectedRevision) && write.expectedRevision < Number.MAX_SAFE_INTEGER))) return {ok:false,error:'MALFORMED'};
    const checked = validatePairingAuthority(write.record); if (!checked.ok) return checked;
    if (write.record.revision !== (write.expectedRevision === null ? 0 : write.expectedRevision + 1)) return {ok:false,error:'MALFORMED'};
    write = snapshot(write);
    try { return await this.run(true,async tx => { const r=write.record, k=key('pairing-authority',r.scope.kind,r.scope.id), old=await tx.get(k); if (old && (old.scope.kind !== r.scope.kind || old.scope.id !== r.scope.id)) corrupt(); if ((old === undefined ? null : old.revision) !== write.expectedRevision) conflict(); await tx.put(k,r); return {ok:true,value:undefined}; }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  private async checkProjection(tx:Tx,p:ProjectionPublication,inputKey:string) {
    const scope=p.expectedAuthority.scope.id;
    const authority=await tx.get(key('pairing-authority','household',scope));
    if(!authority || authority.scope.kind!=='household' || authority.scope.id!==scope || authority.revision<p.nextAuthority.revision || (authority.revision===p.nextAuthority.revision && JSON.stringify(projectionCanonical(authority))!==JSON.stringify(projectionCanonical(p.nextAuthority)))) return corrupt();
    for(const guard of p.guardIds ?? (p.guardId ? [p.guardId] : [])) if(await tx.get(key('pairing-guard',guard))!==inputKey) return corrupt();
    const catalog=await tx.get(key('local-master-catalog'));
    if (!validMasterCatalog(catalog) || JSON.stringify(projectionCanonical(catalog))!==JSON.stringify(projectionCanonical(p.localKey.catalog))) return corrupt();
    let installed; try {installed=await findLocalKey(tx,p.localKey.record.operationId,p.localKey.record.identity);} catch {return corrupt();}
    if (!installed || JSON.stringify(projectionCanonical(installed))!==JSON.stringify(projectionCanonical(p.localKey.record))) return corrupt();
    const manifest=await tx.get(key('projection-manifest',scope,p.manifest.id));
    if (!(manifest instanceof Uint8Array) || !sameBytes(manifest,p.manifest.bytes)) return corrupt();
    for (const d of p.documents) {
      const doc=await tx.get(key('document',scope,d.documentId)), meta=await tx.get(key('projection-document',scope,d.documentId));
      // A document may have advanced after publication; its immutable association remains.
      if (!doc || await tx.get(key('document-owner',scope,d.documentId))!==p.nextAuthority.acceptedParent || !meta || meta.generation!==d.generation || meta.operationId!==p.operationId || (doc.revision===0 && !sameBytes(doc.bytes,d.bytes))) return corrupt();
    }
    for (const pkg of p.packages) {
      const bytes=await tx.get(key('projection-package',scope,pkg.id)), out=await tx.get(key('projection-outbox',scope,p.operationId,pkg.id));
      if (!(bytes instanceof Uint8Array) || !sameBytes(bytes,pkg.bytes) || !out || out.packageId!==pkg.id || out.recipientDevice!==pkg.recipientDevice) return corrupt();
    }
    for (const pending of p.pendingEdits) {
      if (await tx.get(key('projection-pending',scope,p.operationId,pending.scopeId,pending.operationId))!==inputKey || !await this.localOperation(tx,pending.scopeId,pending.operationId)) return corrupt();
    }
  }
  async getProjectionPublication(scopeId:string,operationId:string):Promise<Result<ProjectionPublication|null,StorageError>> {
    if (!validId(scopeId) || !validId(operationId)) return {ok:false,error:'MALFORMED'};
    try { return await this.run(false,async tx=>{ const old=await tx.get(key('projection-publication',scopeId,operationId)); if (!old) return {ok:true,value:null};
      if (old.input.expectedAuthority.scope.id!==scopeId || old.input.operationId!==operationId) return corrupt();
      await this.checkProjection(tx,old.input,old.inputKey); return {ok:true,value:snapshot(old.input)};
    }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  async publishProjection(input:ProjectionPublication):Promise<Result<{replayed:boolean},StorageError>> {
    const inputKey=projectionKey(input); if(inputKey===null)return {ok:false,error:'MALFORMED'}; input=snapshot(input);
    try { return await this.run(true,async tx=>{
      const scope=input.expectedAuthority.scope.id, op=key('projection-publication',scope,input.operationId), old=await tx.get(op);
      if(old) { if(old.inputKey!==inputKey) conflict(); await this.checkProjection(tx,old.input,inputKey); return {ok:true,value:{replayed:true}}; }
      for(const guard of input.guardIds ?? (input.guardId ? [input.guardId] : [])) if(await tx.get(key('pairing-guard',guard))!==undefined) conflict();
      await this.requireAuthority(tx,input.expectedAuthority);
      const authority=await tx.get(key('pairing-authority','household',scope));
      if(!authority || authority.revision!==input.expectedAuthority.record!.revision) conflict();
      if(input.sourceDocument) {
        const source=await tx.get(key('document',scope,input.sourceDocument.documentId));
        const owner=await tx.get(key('document-owner',scope,input.sourceDocument.documentId));
        if(!source || source.revision!==input.sourceDocument.revision || owner!==authority.acceptedParent) conflict();
      }
      if(await tx.get(key('projection-manifest',scope,input.manifest.id))!==undefined) conflict();
      for(const d of input.documents) if(await tx.get(key('document-owner',scope,d.documentId))!==undefined || await tx.get(key('document',scope,d.documentId))!==undefined || await tx.get(key('projection-document',scope,d.documentId))!==undefined) conflict();
      for(const p of input.packages) if(await tx.get(key('projection-package',scope,p.id))!==undefined || await tx.get(key('projection-outbox',scope,input.operationId,p.id))!==undefined) conflict();
      for(const p of input.pendingEdits) { if(!await this.localOperation(tx,p.scopeId,p.operationId)) conflict(); if(await tx.get(key('projection-pending',scope,input.operationId,p.scopeId,p.operationId))!==undefined) conflict(); }
      const installed=await installLocalKey(tx,input.localKey.record,input.localKey.catalog);
      if(JSON.stringify(projectionCanonical(installed.record))!==JSON.stringify(projectionCanonical(input.localKey.record))) conflict();
      await tx.put(key('projection-manifest',scope,input.manifest.id),copy(input.manifest.bytes));
      for(const d of input.documents) { await tx.put(key('document-owner',scope,d.documentId),input.nextAuthority.acceptedParent); await tx.put(key('document',scope,d.documentId),{bytes:copy(d.bytes),revision:0}); await tx.put(key('projection-document',scope,d.documentId),{generation:d.generation,operationId:input.operationId}); }
      for(const p of input.packages) { await tx.put(key('projection-package',scope,p.id),copy(p.bytes)); await tx.put(key('projection-outbox',scope,input.operationId,p.id),{packageId:p.id,recipientDevice:p.recipientDevice}); }
      for(const p of input.pendingEdits) await tx.put(key('projection-pending',scope,input.operationId,p.scopeId,p.operationId),inputKey);
      for(const guard of input.guardIds ?? (input.guardId ? [input.guardId] : [])) await tx.put(key('pairing-guard',guard),inputKey);
      await tx.put(key('pairing-authority','household',scope),input.nextAuthority);
      await tx.put(op,{inputKey,input});
      return {ok:true,value:{replayed:false}};
    }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  private async pairingComplete(tx: Tx, r: PairingRelease, inputKey: string) {
    const s=r.transcript.scope;
    for (const k of [key('pairing-guard',r.guard.guardId),key('pairing-packet',s.kind,s.id,r.packet.id),key('pairing-outbox',s.kind,s.id,r.operationId)]) if (await tx.get(k) !== inputKey) corrupt();
  }
  async findPairingRelease(scope: PairingScope, operationId: string): Promise<Result<PairingRelease | null, StorageError>> {
    if (!validPairingScope(scope) || typeof operationId !== 'string' || !operationId || new TextEncoder().encode(operationId).length > 256) return {ok:false,error:'MALFORMED'};
    scope=snapshot(scope);
    try { return await this.run(false,async tx => { const old=await tx.get(key('pairing-release',scope.kind,scope.id,operationId)); if (!old) return {ok:true,value:null}; const r=old.release; if (r.operationId !== operationId || r.transcript.scope.kind !== scope.kind || r.transcript.scope.id !== scope.id) corrupt(); await this.pairingComplete(tx,r,old.inputKey); return {ok:true,value:snapshot(r)}; }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  async commitPairingRelease(r: PairingRelease): Promise<PairingReleaseResult> {
    const checked=pairingReleaseKey(r); if (!checked.ok) return fail(checked.error === 'UNSUPPORTED_VERSION' ? 'UNSUPPORTED_VERSION' : checked.error); r=snapshot(r);
    try { return await this.run(true,async tx => {
      const s=r.transcript.scope, op=key('pairing-release',s.kind,s.id,r.operationId), guard=key('pairing-guard',r.guard.guardId), packet=key('pairing-packet',s.kind,s.id,r.packet.id), outbox=key('pairing-outbox',s.kind,s.id,r.operationId);
      const old=await tx.get(op);
      if (old !== undefined) { if (old.inputKey !== checked.value) conflict(); await this.pairingComplete(tx,old.release,old.inputKey); return {ok:true,value:{release:snapshot(old.release),replayed:true}}; }
      if (await tx.get(guard) !== undefined || await tx.get(packet) !== undefined || await tx.get(outbox) !== undefined) conflict();
      const authority=await tx.get(key('pairing-authority',s.kind,s.id));
      if (authority && (authority.scope.kind !== s.kind || authority.scope.id !== s.id)) corrupt();
      if (!authority || authority.revision !== r.expectedAuthorityRevision || authority.acceptedParent !== r.transcript.acceptedParent || authority.authorizationSnapshot !== r.transcript.authorizationSnapshot) conflict();
      await tx.put(guard,checked.value); await tx.put(packet,checked.value); await tx.put(outbox,checked.value); await tx.put(op,{inputKey:checked.value,release:r});
      return {ok:true,value:{release:snapshot(r),replayed:false}};
    }); } catch(e) { return fail(mapError(e)); }
  }
  private async requireAuthority(tx: Tx, condition: LocalCommit['expectedAuthority']) {
    const {scope,record}=condition; const current=await tx.get(key('pairing-authority',scope.kind,scope.id));
    if (current && (current.scope.kind!==scope.kind || current.scope.id!==scope.id)) corrupt();
    if (record === null) { if (current !== undefined) conflict(); return; }
    if (!current || current.revision!==record.revision || current.acceptedParent!==record.acceptedParent || current.authorizationSnapshot!==record.authorizationSnapshot) conflict();
  }
  private async identities(tx: Tx, c: LocalCommit) {
    const ids = [key('local',c.scopeId,c.operationId), ...c.commands.flatMap(x => [key('command',c.scopeId,x.commandId), key('effect',c.scopeId,x.effectId)]), ...c.outbound.map(x => key('object',c.scopeId,x.object.id))];
    for (const id of ids) if (await tx.get(id) !== undefined) conflict();
  }
  private async completedLocal(tx: Tx, c: LocalCommit, inputKey: string) {
    for (const command of c.commands) {
      if (await tx.get(key('command',c.scopeId,command.commandId)) !== inputKey || await tx.get(key('effect',c.scopeId,command.effectId)) !== inputKey) conflict();
    }
    for (const entry of c.outbound) {
      const object = await tx.get(key('object',c.scopeId,entry.object.id));
      if (!object || !sameBytes(object.bytes,entry.object.bytes) || object.branchHead !== entry.branchHead || object.epochId !== entry.epochId) conflict();
    }
  }
  private async documents(tx: Tx, scope: string, docs: LocalCommit['documents'], owner: string | null): Promise<SavedOutcome> {
    const revisions: {documentId:string;revision:number}[] = [];
    for (const d of docs) {
      const old = await tx.get(key('document',scope,d.documentId));
      const oldOwner=await tx.get(key('document-owner',scope,d.documentId));
      if (owner && old && oldOwner!==owner) throw new StorageFailure('CHECKOUT_REQUIRED');
      if (owner && !old && oldOwner!==undefined) return corrupt();
      if ((old === undefined ? null : old.revision) !== d.expectedRevision || old?.revision === Number.MAX_SAFE_INTEGER) conflict();
      revisions.push({documentId:d.documentId,revision:old === undefined ? 0 : old.revision + 1});
    }
    for (let i=0;i<docs.length;i++) { if (owner && docs[i].expectedRevision===null) await tx.put(key('document-owner',scope,docs[i].documentId),owner); await tx.put(key('document',scope,docs[i].documentId), {bytes:copy(docs[i].bytes),revision:revisions[i].revision}); }
    return {state:'saved',revisions};
  }
  /** Dependencies are scope-local and must precede their consumer in the transaction. */
  private async requireDependencies(tx:Tx,scopeId:string,commands:readonly {effectId:string;dependencyEffectIds:readonly string[]}[]) {
    const prior=new Set<string>();
    for(const command of commands) {
      for(const dep of command.dependencyEffectIds) if(!prior.has(dep) && await tx.get(key('effect',scopeId,dep))===undefined) conflict();
      prior.add(command.effectId);
    }
  }
  private async local(tx: Tx, c: LocalCommit, inputKey: string) {
    await this.identities(tx,c);
    await this.requireDependencies(tx,c.scopeId,c.commands);
    const outcome = await this.documents(tx,c.scopeId,c.documents,c.expectedAuthority.record?.acceptedParent ?? null);
    for (const command of c.commands) {
      await tx.put(key('command',c.scopeId,command.commandId), inputKey);
      await tx.put(key('effect',c.scopeId,command.effectId), inputKey);
    }
    for (const entry of c.outbound) await tx.put(key('object',c.scopeId,entry.object.id), {bytes:copy(entry.object.bytes),branchHead:entry.branchHead,epochId:entry.epochId});
    await tx.put(key('local',c.scopeId,c.operationId), {inputKey,outcome});
    return outcome;
  }
  async commitLocal(c: LocalCommit): Promise<CommitResult> {
    const k = storageOperationKey(c,'local'); if (!k.ok) return fail(k.error); c = snapshot(c);
    try { return await this.run(true, async tx => {
      const old = await tx.get(key('local',c.scopeId,c.operationId));
      if (old !== undefined) { if (old.inputKey !== k.value || !old.outcome) conflict(); validateOutcome(old.outcome,c.documents); await this.completedLocal(tx,c,k.value); return {ok:true,value:{outcome:old.outcome,replayed:true}}; }
      await this.requireAuthority(tx,c.expectedAuthority);
      const outcome = await this.local(tx,c,k.value); this.fault?.('local');
      return {ok:true,value:{outcome,replayed:false}};
    }); } catch (e) { return fail(mapError(e)); }
  }
  async commitLocalGroup(g: LocalCommitGroup): Promise<GroupCommitResult> {
    const k = storageGroupKey(g); if (!k.ok) return fail(k.error); g = snapshot(g);
    try { return await this.run(true, async tx => {
      const old = await tx.get(key('group',g.groupId));
      if (old !== undefined) { if (old.inputKey !== k.value || !old.outcomes || old.outcomes.length !== g.children.length) conflict(); for (const c of g.children) { const ck = storageOperationKey(c,'local'); if (!ck.ok) throw new StorageFailure(ck.error); const operation = await tx.get(key('local',c.scopeId,c.operationId)); if (!operation || operation.inputKey !== ck.value || !operation.outcome) conflict(); validateOutcome(operation.outcome,c.documents); const index = g.children.indexOf(c); validateOutcome(old.outcomes[index],c.documents); if (JSON.stringify(old.outcomes[index]) !== JSON.stringify(operation.outcome)) corrupt(); await this.completedLocal(tx,c,ck.value); } return {ok:true,value:{outcomes:old.outcomes,replayed:true}}; }
      for (const c of g.children) { await this.requireAuthority(tx,c.expectedAuthority); await this.identities(tx,c); }
      const outcomes: SavedOutcome[] = [];
      for (const c of g.children) { const ck = storageOperationKey(c,'local'); if (!ck.ok) throw new StorageFailure(ck.error); outcomes.push(await this.local(tx,c,ck.value)); this.fault?.('child'); }
      await tx.put(key('group',g.groupId),{inputKey:k.value,outcomes}); this.fault?.('group');
      return {ok:true,value:{outcomes,replayed:false}};
    }); } catch (e) { return fail(mapError(e)); }
  }
  async reopenBranchDocument(expectedAuthority: LocalCommit['expectedAuthority'], documentId:string):Promise<Result<{documentId:string;bytes:Uint8Array;revision:number}|null,StorageError>> {
    if (!expectedAuthority || !validPairingScope(expectedAuthority.scope) || !expectedAuthority.record || !validId(documentId)) return {ok:false,error:'MALFORMED'};
    expectedAuthority=snapshot(expectedAuthority);
    try { return await this.run(false,async tx=>{ await this.requireAuthority(tx,expectedAuthority); const scope=expectedAuthority.scope.id, doc=await tx.get(key('document',scope,documentId));
      const owner=await tx.get(key('document-owner',scope,documentId));
      if (!doc) { if(owner!==undefined) return corrupt(); return {ok:true,value:null}; }
      if (owner!==expectedAuthority.record!.acceptedParent) throw new StorageFailure('CHECKOUT_REQUIRED');
      return {ok:true,value:{documentId,bytes:copy(doc.bytes),revision:doc.revision}};
    }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  async reopenDocument(scopeId: string, documentId: string): Promise<Result<({documentId:string;bytes:Uint8Array;revision:number}) | null,StorageError>> {
    try { return await this.run(false,async tx => { const d = await tx.get(key('document',scopeId,documentId)); return {ok:true,value:d === undefined ? null : {documentId,bytes:copy(d.bytes),revision:d.revision}}; }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  async stageInbox(item: InboxItem): Promise<Result<void,StorageError>> {
    const valid = validateInboxItem(item); if (!valid.ok) return valid; item = snapshot(item);
    try { return await this.run(true,async tx => {
      const cursorKey = key('cursor',item.scopeId,item.source), itemKey = key('inbox',item.scopeId,item.object.id);
      const cursor = await tx.get(cursorKey), old = await tx.get(itemKey);
      if ((cursor === undefined ? null : cursor) !== item.expectedCursor || (old !== undefined && !sameBytes(old.bytes,item.object.bytes))) conflict();
      if (old === undefined) await tx.put(itemKey,{bytes:copy(item.object.bytes)});
      this.fault?.('inbox'); await tx.put(cursorKey,item.cursor); this.fault?.('cursor');
      return {ok:true,value:undefined};
    }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  async commitImport(c: ImportCommit): Promise<CommitResult> {
    const k = storageOperationKey(c,'import'); if (!k.ok) return fail(k.error); c = snapshot(c);
    try { return await this.run(true,async tx => {
      const op = key('import',c.scopeId,c.operationId), old = await tx.get(op);
      if (old !== undefined) { if (old.inputKey !== k.value || !old.outcome || await tx.get(key('applied',c.scopeId,c.itemId)) !== c.operationId || await tx.get(key('inbox',c.scopeId,c.itemId)) === undefined) conflict(); for (const command of c.commands) if (await tx.get(key('command',c.scopeId,command.commandId)) !== k.value || await tx.get(key('effect',c.scopeId,command.effectId)) !== k.value) conflict(); validateOutcome(old.outcome,c.documents); return {ok:true,value:{outcome:old.outcome,replayed:true}}; }
      await this.requireAuthority(tx,c.expectedAuthority);
      if (await tx.get(key('inbox',c.scopeId,c.itemId)) === undefined || await tx.get(key('applied',c.scopeId,c.itemId)) !== undefined) conflict();
      for (const command of c.commands) if (await tx.get(key('command',c.scopeId,command.commandId)) !== undefined || await tx.get(key('effect',c.scopeId,command.effectId)) !== undefined) conflict();
      await this.requireDependencies(tx,c.scopeId,c.commands);
      const outcome = await this.documents(tx,c.scopeId,c.documents,c.expectedAuthority.record?.acceptedParent ?? null); this.fault?.('import-documents');
      for (const command of c.commands) { await tx.put(key('command',c.scopeId,command.commandId),k.value); await tx.put(key('effect',c.scopeId,command.effectId),k.value); }
      await tx.put(key('applied',c.scopeId,c.itemId),c.operationId);
      await tx.put(op,{inputKey:k.value,outcome}); this.fault?.('import');
      return {ok:true,value:{outcome,replayed:false}};
    }); } catch(e) { return fail(mapError(e)); }
  }
  async recordReceipt(r: OutboxReceipt): Promise<Result<{replayed:boolean},StorageError>> {
    const valid = validateStorageReceipt(r); if (!valid.ok) return valid; r = snapshot(r);
    try { return await this.run(true,async tx => {
      const rk = key('receipt',r.scopeId,r.receiptId), old = await tx.get(rk);
      const representation = JSON.stringify([r.objectId,r.destination,r.recipientId,r.state,Array.from(r.bytes)]);
      if (old !== undefined) { if (old !== representation) conflict(); return {ok:true,value:{replayed:true}}; }
      if (await tx.get(key('object',r.scopeId,r.objectId)) === undefined) conflict();
      const stateKey = key('receipt-state',r.scopeId,r.objectId,r.destination,r.recipientId), state = await tx.get(stateKey);
      if (r.state === 'applied' && state !== 'stored' && state !== 'applied') conflict();
      if (r.state === 'stored' && state === 'applied') conflict();
      await tx.put(rk,representation); await tx.put(stateKey,r.state); this.fault?.('receipt');
      return {ok:true,value:{replayed:false}};
    }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
}
