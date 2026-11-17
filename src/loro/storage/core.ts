import { pairingReleaseKey, validatePairingAuthority, validPairingScope } from '../contracts/pairing.ts';
import type { RuntimeStorageReader } from '../contracts/runtime-storage.ts';
import type { PairingAtomicStorage, PairingAuthorityRecord, PairingAuthorityWrite, PairingRelease, PairingReleaseResult, PairingScope } from '../contracts/pairing.ts';
import { storageOperationKey, storageGroupKey, validateInboxItem, validateStorageReceipt } from '../contracts/index.ts';
import type { AtomicStorage, CommitResult, GroupCommitResult, LocalCommit, LocalCommitGroup, ImportCommit, InboxItem, OutboxReceipt, StorageError, SavedOutcome, Result } from '../contracts/index.ts';

type Tx = { get(key: string): Promise<any>; put(key: string, value: any): Promise<void>; keys(): Promise<string[]> };
export type TransactionRunner = <T>(write: boolean, body: (tx: Tx) => Promise<T>) => Promise<T>;
const key = (...parts: string[]) => JSON.stringify(parts);
const conflict = (): never => { throw new StorageFailure('CONFLICT'); };
export class StorageFailure extends Error { readonly code: StorageError; constructor(code: StorageError) { super(code); this.code = code; } }
const mapError = (e: unknown): StorageError => e instanceof StorageFailure ? e.code : e instanceof Error && (e.name === 'QuotaExceededError' || /SQLITE_FULL|database or disk is full/i.test(e.message)) ? 'CAPACITY' : 'IO';
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
    case 'pairing-authority': valid = validatePairingAuthority(v).ok; break;
    case 'pairing-release': { const parsed = fields(v,['inputKey','release']) ? pairingReleaseKey(v.release) : null; valid = !!parsed && parsed.ok && parsed.value === v.inputKey; break; }
    case 'pairing-guard': case 'pairing-packet': case 'pairing-outbox': valid = typeof v === 'string' && v.length > 0; break;
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

/** Database transactions, not process locks, provide isolation. */
export class TransactionalStorage implements AtomicStorage, PairingAtomicStorage, RuntimeStorageReader {
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
  async getLocalOperation(scopeId: string, operationId: string): Promise<Result<{commit: LocalCommit; outcome: SavedOutcome} | null, StorageError>> {
    if (![scopeId,operationId].every(x=>typeof x==='string' && !!x && new TextEncoder().encode(x).length<=256)) return {ok:false,error:'MALFORMED'};
    try { return await this.run(false,async tx => {
      const old=await tx.get(key('local',scopeId,operationId)); if (!old) return {ok:true,value:null};
      let c: LocalCommit; try { const parsed=JSON.parse(old.inputKey); if (!Array.isArray(parsed) || parsed[0]!=='local' || parsed.length!==2) return corrupt(); c=parsed[1];
        for (const d of c.documents) d.bytes = decodeKeyBytes(d.bytes); for (const cmd of c.commands) cmd.payload = decodeKeyBytes(cmd.payload); for (const o of c.outbound) o.object.bytes = decodeKeyBytes(o.object.bytes);
      } catch { return corrupt(); }
      if (!Object.hasOwn(c,'expectedAuthority')) return {ok:false,error:'UNSUPPORTED_VERSION'}; const checked=storageOperationKey(c,'local'); if (!checked.ok || checked.value!==old.inputKey || c.scopeId!==scopeId || c.operationId!==operationId) return corrupt();
      validateOutcome(old.outcome,c.documents); try { await this.completedLocal(tx,c,old.inputKey); } catch (e) { if (e instanceof StorageFailure && e.code === 'CONFLICT') corrupt(); throw e; } return {ok:true,value:{commit:snapshot(c),outcome:snapshot(old.outcome)}};
    }); } catch(e) { return {ok:false,error:mapError(e)}; }
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
  private async documents(tx: Tx, scope: string, docs: LocalCommit['documents']): Promise<SavedOutcome> {
    const revisions: {documentId:string;revision:number}[] = [];
    for (const d of docs) {
      const old = await tx.get(key('document',scope,d.documentId));
      if ((old === undefined ? null : old.revision) !== d.expectedRevision || old?.revision === Number.MAX_SAFE_INTEGER) conflict();
      revisions.push({documentId:d.documentId,revision:old === undefined ? 0 : old.revision + 1});
    }
    for (let i=0;i<docs.length;i++) await tx.put(key('document',scope,docs[i].documentId), {bytes:copy(docs[i].bytes),revision:revisions[i].revision});
    return {state:'saved',revisions};
  }
  private async local(tx: Tx, c: LocalCommit, inputKey: string) {
    await this.identities(tx,c);
    const outcome = await this.documents(tx,c.scopeId,c.documents);
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
      const outcome = await this.documents(tx,c.scopeId,c.documents); this.fault?.('import-documents');
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
