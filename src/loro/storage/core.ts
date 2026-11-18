import {readLocalQuarantine} from '../compromise/review.mjs';
import {readContinuityHead} from './continuity-head.ts';
import {findLocalKey,installLocalKey,validLocalRecord,validMasterCatalog} from './local-keys.ts';
import { pairingReleaseKey, validatePairingAuthority, validPairingScope } from '../contracts/pairing.ts';
import type { ProjectionPublication, ProjectionAtomicStorage } from '../contracts/projection.ts';
import type { RuntimeStorageReader } from '../contracts/runtime-storage.ts';
import type { PairingAtomicStorage, PairingAuthorityRecord, PairingAuthorityWrite, PairingRelease, PairingReleaseResult, PairingScope } from '../contracts/pairing.ts';
import { storageOperationKey, storageGroupKey, validateInboxItem, validateStorageReceipt } from '../contracts/index.ts';
import {isPolicyDocumentId} from '../authority/validator.mjs';
import type { AtomicStorage, CommitResult, GroupCommitResult, LocalCommit, LocalCommitGroup, ImportCommit, InboxItem, OutboxReceipt, StorageError, SavedOutcome, Result } from '../contracts/index.ts';

type Tx = { get(key: string): Promise<any>; put(key: string, value: any): Promise<void>; keys(): Promise<string[]> };
type AuthorityExpectation = LocalCommit['expectedAuthority'];
type BranchDocument = {head:string;documentId:string};
type BranchRevision = BranchDocument & {revision:number|null};
type PolicyCheckout = {
  expectedAuthority:AuthorityExpectation;
  nextAuthority:PairingAuthorityRecord;
  from:BranchRevision;
  target:BranchRevision;
  parent:BranchRevision|null;
  baseline:Uint8Array|null;
};
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
    case 'compromise-quarantine': valid=typeof v==='boolean'; break;
    case 'disclosure-pending': valid=fields(v,['reason','objectId']) && v.reason==='POLICY_GOVERNANCE_UNPROVEN' && typeof v.objectId==='string' && !!v.objectId; break;
    case 'disclosure-active': case 'policy-disclosure-head': valid=v===null || typeof v==='string' && !!v; break;
    case 'policy-checkout-parent': valid=validBranchDocument(v); break;
    case 'disclosure-policy-archive': case 'disclosure-policy': valid=fields(v,['policy','policyHash','approvals']) && object(v.policy) && typeof v.policyHash==='string' && Array.isArray(v.approvals); break;
    case 'disclosure-source': valid=(fields(v,['policyHashes','checkpoint','documentId','commandId','envelope','origin','objectId']) || (fields(v,['policyHashes','checkpoint','documentId','commandId','envelope','origin','objectId','incomplete']) && v.incomplete===true)) && v.envelope instanceof Uint8Array && ['local','import'].includes(v.origin) && typeof v.objectId==='string' && !!v.objectId && denseArray(v.policyHashes,(x:any)=>typeof x==='string' && !!x) && typeof v.checkpoint==='string' && !!v.checkpoint && typeof v.documentId==='string' && !!v.documentId && typeof v.commandId==='string' && !!v.commandId; break;
    case 'disclosure-review': valid=(fields(v,['record','state']) || (fields(v,['record','state','context']) && object(v.context))) && object(v.record) && ['reviewed','unknown','sent','failed'].includes(v.state); break;
    case 'household-sealed-file': valid=fields(v,['version','digest','bytes','signature']) && v.version===1 && typeof v.digest==='string' && /^[0-9a-f]{64}$/.test(v.digest) && v.bytes instanceof Uint8Array && v.bytes.length>=48 && v.bytes.length<=16*1024*1024+48 && v.signature instanceof Uint8Array && v.signature.length===64; break;
    case 'projection-policy-seed': valid=fields(v,['bundle','bundleHash']) && object(v.bundle) && validId(v.bundleHash); break;
    case 'projection-seed-command': case 'projection-seed-effect': valid=typeof v==='string' && !!v; break;
    case 'projection-seed': valid=fields(v,['seedId','identities']) && typeof v.seedId==='string' && denseArray(v.identities,(x:any)=>fields(x,['commandId','effectId']) && typeof x.commandId==='string' && !!x.commandId && typeof x.effectId==='string' && !!x.effectId); break;
    case 'continuity-binding': valid=fields(v,['version','binding','bindingSignature','bindingHash']) && v.version===1 && object(v.binding) && typeof v.bindingSignature==='string' && typeof v.bindingHash==='string' && !!v.bindingHash; break;
    case 'continuity-head': valid=fields(v,['generation','bindingHash']) && revision(v.generation) && typeof v.bindingHash==='string' && !!v.bindingHash; break;
    case 'recovery-readmission-challenge': valid=fields(v,['claimHash','tokenCommitment','sealed']) && [v.claimHash,v.tokenCommitment,v.sealed].every((x:any)=>typeof x==='string'&&!!x); break;
    case 'recovery-challenge-consumed': valid=typeof v==='string' && !!v; break;
    case 'local-master-catalog': valid = validMasterCatalog(v) || (fields(v,['version','state','id']) && v.version===1 && v.state==='reserved' && typeof v.id==='string' && !!v.id); break;
    case 'local-key': case 'local-key-operation': valid = validLocalRecord(v); break;
    case 'projection-publication': valid = fields(v,['inputKey','input']) && typeof v.inputKey==='string' && projectionKey(v.input)===v.inputKey; break;
    case 'projection-manifest': case 'projection-package': valid = v instanceof Uint8Array; break;
    case 'projection-outbox': valid = fields(v,['packageId','recipientDevice']) && typeof v.packageId==='string' && typeof v.recipientDevice==='string'; break;
    case 'projection-pending': valid = typeof v==='string'; break;
    case 'projection-document': valid = fields(v,['generation','operationId']) && revision(v.generation) && typeof v.operationId==='string'; break;
    case 'pairing-authority': valid = validatePairingAuthority(v).ok; break;
    case 'pairing-release': { const parsed = fields(v,['inputKey','release']) ? pairingReleaseKey(v.release) : null; valid = !!parsed && parsed.ok && parsed.value === v.inputKey; break; }
    case 'pairing-guard': case 'pairing-packet': case 'pairing-outbox': case 'personal-admission-release': valid = typeof v === 'string' && v.length > 0; break;
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
const validBranchDocument = (x: unknown): x is BranchDocument => fields(x,['head','documentId']) && validId(x.head) && validId(x.documentId);
const validBranchRevision = (x: unknown): x is BranchRevision => fields(x,['head','documentId','revision']) && validId(x.head) && validId(x.documentId) && (x.revision===null || revision(x.revision));
const projectionCanonical = (v: unknown): unknown => v instanceof Uint8Array ? Array.from(v) : Array.isArray(v) ? v.map(projectionCanonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,projectionCanonical(v[k])])) : v;
function projectionKey(x: unknown,allowUnboundV2=false): string | null {
 if(object(x)&&Object.hasOwn(x,'policySeed')){const {policySeed,...rest}=x;if(!fields(policySeed,['bundle','bundleHash'])||!object(policySeed.bundle)||!validId(policySeed.bundleHash)||!rest.seed||!rest.sourceDocument||!rest.manifest||!(rest.manifest.bytes instanceof Uint8Array))return null;let m:any;try{m=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rest.manifest.bytes))}catch{return null}const b:any=policySeed.bundle;if(!fields(b,['version','scopeId','sourceHead','sourceDocumentId','sourceRevision','seedId','peerId','snapshotHash','entries','policies'])||![2,3,4].includes(b.version)||m.version!==b.version||m.policyBundleHash!==policySeed.bundleHash||m.sourceRevision!==b.sourceRevision||m.sourceDocument!==b.sourceDocumentId||b.sourceDocumentId!==rest.sourceDocument.documentId||b.sourceRevision!==rest.sourceDocument.revision||b.sourceHead!==rest.expectedAuthority?.record?.acceptedParent||b.scopeId!==rest.expectedAuthority?.scope?.id||b.seedId!==rest.seed.seedId||m.schemaVersion!==`registry-seed-v${b.version}|${b.seedId}|${b.peerId}`||!validId(b.snapshotHash)||!denseArray(b.entries,(e:any)=>(b.version===2?fields(e,['effectId','policyHashes']):fields(e,['effectId','policyHashes','incomplete'])&&typeof e.incomplete==='boolean')&&validId(e.effectId)&&denseArray(e.policyHashes,validId)&&(e.policyHashes.length>0||b.version>=3&&e.incomplete===true)&&e.policyHashes.length<=64&&e.policyHashes.every((h:string,i:number)=>!i||e.policyHashes[i-1]<h))||b.entries.length>256||!denseArray(b.policies,(p:any)=>fields(p,['policy','policyHash','approvals'])&&object(p.policy)&&validId(p.policyHash)&&Array.isArray(p.approvals))||b.policies.length>64||!Array.isArray(rest.seed.identities)||JSON.stringify(b.entries.map((e:any)=>e.effectId))!==JSON.stringify(rest.seed.identities.map((e:any)=>e.effectId).sort())||projectionKey(rest,true)===null)return null;const encoded=JSON.stringify(projectionCanonical(x));return new TextEncoder().encode(encoded).length<=2500000?encoded:null;}
 if(object(x)&&Object.hasOwn(x,'seed')){const {seed,...rest}=x;if(!fields(seed,['seedId','identities'])||!validId(seed.seedId)||!denseArray(seed.identities,(i:any)=>fields(i,['commandId','effectId'])&&validId(i.commandId)&&validId(i.effectId))||seed.identities.length>256||new Set(seed.identities.map((i:any)=>i.commandId)).size!==seed.identities.length||new Set(seed.identities.map((i:any)=>i.effectId)).size!==seed.identities.length||projectionKey(rest,allowUnboundV2)===null)return null;return JSON.stringify(projectionCanonical(x));}
 if(object(x)&&Object.hasOwn(x,'singleRecipient')){const {singleRecipient,...rest}=x;if(singleRecipient!==true||!Array.isArray(rest.packages)||rest.packages.length!==0||Object.hasOwn(rest,'guardId')||Object.hasOwn(rest,'guardIds')||Object.hasOwn(rest,'recovery')||projectionKey({...rest,guardIds:['local-only-placeholder'],packages:[{id:'local-only-placeholder',recipientDevice:'local-only-placeholder',bytes:new Uint8Array([0])}]},allowUnboundV2)===null)return null;return JSON.stringify(projectionCanonical(x));}
 if(object(x)&&Object.hasOwn(x,'recovery')){const r=x.recovery,{recovery,...rest}=x;if(!fields(r,['owner','generation','bindingHash','claimHash','tokenCommitment','sealed'])||!validId(r.owner)||!revision(r.generation)||![r.bindingHash,r.claimHash,r.tokenCommitment].every(validId)||typeof r.sealed!=='string'||r.sealed.length>16384||!/^[0-9a-f]+$/.test(r.sealed)||projectionKey(rest,allowUnboundV2)===null)return null;return JSON.stringify(projectionCanonical(x));}
 if(!allowUnboundV2&&object(x)&&object(x.manifest)&&x.manifest.bytes instanceof Uint8Array){try{if([2,3,4].includes(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(x.manifest.bytes))?.version))return null}catch{}}
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
  /** Conservative archive manifest: retain every locally committed operation
   * with an outbound object from the selected branch. No delivery is inferred. */
  async listBranchLocalOperations(expectedAuthority:LocalCommit['expectedAuthority']):Promise<Result<{scopeId:string;operationId:string}[],StorageError>> {
    expectedAuthority=snapshot(expectedAuthority);if(!expectedAuthority||expectedAuthority.scope?.kind!=='household'||!validId(expectedAuthority.scope.id)||!expectedAuthority.record||!validId(expectedAuthority.record.acceptedParent))return {ok:false,error:'MALFORMED'};
    try{return await this.run(false,async tx=>{await this.requireAuthority(tx,expectedAuthority);const scopeId=expectedAuthority.scope.id,head=expectedAuthority.record!.acceptedParent,result:{scopeId:string;operationId:string}[]=[];for(const raw of await tx.keys()){let parts:any;try{parts=JSON.parse(raw)}catch{continue}if(!Array.isArray(parts)||parts[0]!=='local'||parts[1]!==scopeId)continue;if(parts.length!==3||!validId(parts[2]))return corrupt();const found=await this.localOperation(tx,scopeId,parts[2]);if(!found)return corrupt();if(found.commit.outbound.some(x=>x.branchHead===head)){result.push({scopeId,operationId:parts[2]});if(result.length>256)throw new StorageFailure('TOO_LARGE')}}result.sort((a,b)=>a.operationId<b.operationId?-1:a.operationId>b.operationId?1:0);return {ok:true as const,value:result}})}catch(e){return {ok:false,error:mapError(e)}}
  }
  async getLocalOperation(scopeId:string,operationId:string):Promise<Result<{commit:LocalCommit;outcome:SavedOutcome}|null,StorageError>> {
    if (![scopeId,operationId].every(validId)) return {ok:false,error:'MALFORMED'};
    try {return await this.run(false,async tx=>({ok:true,value:await this.localOperation(tx,scopeId,operationId)}));} catch(e){return {ok:false,error:mapError(e)};}
  }
  private async importedOperation(tx:Tx,scopeId:string,itemId:string):Promise<{commit:ImportCommit;outcome:SavedOutcome}|null> {
    const op=await tx.get(key('applied',scopeId,itemId));if(op===undefined)return null;const old=await tx.get(key('import',scopeId,op));if(!old)return corrupt();
    let c:ImportCommit;try{const parsed=JSON.parse(old.inputKey);if(!Array.isArray(parsed)||parsed[0]!=='import'||parsed.length!==2)return corrupt();c=parsed[1];for(const d of c.documents)d.bytes=decodeKeyBytes(d.bytes);if(c.version===2&&Array.isArray(c.commands))for(const command of c.commands)command.payload=decodeKeyBytes(command.payload)}catch{return corrupt()}
    if(!Object.hasOwn(c,'expectedAuthority')||c.version!==2||!Object.hasOwn(c,'commands'))throw new StorageFailure('UNSUPPORTED_VERSION');const checked=storageOperationKey(c,'import');if(!checked.ok||checked.value!==old.inputKey||c.scopeId!==scopeId||c.itemId!==itemId||c.operationId!==op)return corrupt();validateOutcome(old.outcome,c.documents);try{await this.completedImport(tx,c,old.inputKey)}catch(e){if(e instanceof StorageFailure&&e.code==='CONFLICT')return corrupt();throw e}return {commit:snapshot(c),outcome:snapshot(old.outcome)};
  }
  async getInboxApplication(scopeId:string,itemId:string,bytes?:Uint8Array):Promise<Result<{operationId:string;outcome:SavedOutcome}|null,StorageError>> {
    if (![scopeId,itemId].every(validId) || (bytes !== undefined && !(bytes instanceof Uint8Array))) {
      return {ok:false,error:'MALFORMED'};
    }
    try {
      return await this.run(false,async tx=>{
        const found = await this.importedOperation(tx,scopeId,itemId);
        if (!found) return {ok:true,value:null};
        if (bytes !== undefined && !sameBytes((await tx.get(key('inbox',scopeId,itemId))).bytes,bytes)) conflict();
        return {ok:true,value:{operationId:found.commit.operationId,outcome:found.outcome}};
      });
    } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  async getDisclosureImport(scopeId:string,itemId:string) {
    if(![scopeId,itemId].every(validId))return fail('MALFORMED');try{return await this.run(false,async tx=>{const found=await this.importedOperation(tx,scopeId,itemId);if(!found)return {ok:true as const,value:null};if(found.commit.commands.length!==1)return corrupt();const source=await this.validatedDisclosureSource(tx,scopeId,found.commit.commands[0].effectId);if(!source||source.origin!=='import'||source.objectId!==itemId)return corrupt();return {ok:true as const,value:{...found,source:snapshot(source)}}})}catch(e){return fail(mapError(e))}
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
  private async checkoutDocument(tx:Tx,scope:string,{head,documentId}:BranchDocument,allowUninstalled=false):Promise<{bytes:Uint8Array;revision:number}|null> {
    const doc=await tx.get(key('document',scope,documentId)), owner=await tx.get(key('document-owner',scope,documentId));
    if(isPolicyDocumentId(documentId)) {
      const parent=await tx.get(key('policy-checkout-parent',scope,documentId));
      if(documentId!==`policy-${head}` || (!parent && (!allowUninstalled || doc || owner!==undefined))) throw new StorageFailure('CHECKOUT_REQUIRED');
      if(parent && !doc) return corrupt();
    }
    if(doc ? owner!==head : owner!==undefined) throw new StorageFailure('CHECKOUT_REQUIRED');
    return doc??null;
  }
  /** These read-only observations are for the verified checkout path only. */
  async readPolicyCheckoutDocuments(expected:AuthorityExpectation,from:BranchDocument,target:BranchDocument,parent:BranchDocument|null) {
    if(expected?.scope?.kind!=='household'||!validBranchDocument(from)||!validBranchDocument(target)||
      expected.record?.acceptedParent!==from.head||from.head===target.head||from.documentId===target.documentId||
      (parent!==null&&!validBranchDocument(parent))) return fail('MALFORMED');
    try{return await this.run(false,async tx=>{
      await this.requireAuthority(tx,expected);
      const scope=expected.scope.id;
      const source=await this.checkoutDocument(tx,scope,from);
      const destination=await this.checkoutDocument(tx,scope,target,parent!==null);
      const parentDocument=parent && !destination ? await this.checkoutDocument(tx,scope,parent) : null;
      return {ok:true as const,value:{fromRevision:source?.revision??null,targetRevision:destination?.revision??null,parentDocument:snapshot(parentDocument)}};
    })}catch(e){return fail(mapError(e));}
  }
  /** Install the exact reconstructed baseline and publish the local selection together. */
  async commitPolicyCheckout(input:PolicyCheckout) {
    input=snapshot(input);
    const {expectedAuthority,nextAuthority,from,target,parent,baseline}=input;
    if(expectedAuthority?.scope?.kind!=='household'||!expectedAuthority.record||!validatePairingAuthority(nextAuthority).ok||
      nextAuthority.scope.kind!=='household'||nextAuthority.scope.id!==expectedAuthority.scope.id||
      nextAuthority.revision!==expectedAuthority.record.revision+1||!validBranchRevision(from)||!validBranchRevision(target)||
      expectedAuthority.record.acceptedParent!==from.head||nextAuthority.acceptedParent!==target.head||
      from.head===target.head||from.documentId===target.documentId||
      (parent===null ? isPolicyDocumentId(target.documentId) : !validBranchRevision(parent)||target.documentId!==`policy-${target.head}`||parent.documentId===target.documentId)||
      (parent!==null&&target.revision===null ? !(baseline instanceof Uint8Array)||!baseline.length : baseline!==null)) return fail('MALFORMED');
    try{return await this.run(true,async tx=>{
      await this.requireAuthority(tx,expectedAuthority);
      const scope=expectedAuthority.scope.id;
      const source=await this.checkoutDocument(tx,scope,from), destination=await this.checkoutDocument(tx,scope,target,parent!==null);
      if((source?.revision??null)!==from.revision||(destination?.revision??null)!==target.revision) conflict();
      if(parent) {
        const expectedParent={head:parent.head,documentId:parent.documentId};
        if(baseline) {
          const retained=await this.checkoutDocument(tx,scope,parent);
          if((retained?.revision??null)!==parent.revision) conflict();
          await tx.put(key('document-owner',scope,target.documentId),target.head);
          await tx.put(key('document',scope,target.documentId),{bytes:copy(baseline),revision:0});
          await tx.put(key('policy-checkout-parent',scope,target.documentId),expectedParent);
        } else {
          const saved=await tx.get(key('policy-checkout-parent',scope,target.documentId));
          if(saved?.head!==parent.head||saved?.documentId!==parent.documentId) return corrupt();
        }
      }
      const active=(await tx.get(key('disclosure-active',scope)))??null;
      await tx.put(key('policy-disclosure-head',scope,from.head),active);
      let next=await tx.get(key('policy-disclosure-head',scope,target.head));
      if(next===undefined&&parent&&baseline) next=await tx.get(key('policy-disclosure-head',scope,parent.head));
      if(next===undefined) return corrupt();
      await tx.put(key('disclosure-active',scope),next);
      await tx.put(key('pairing-authority','household',scope),nextAuthority);
      this.fault?.('policy-checkout');
      return {ok:true as const,value:undefined};
    })}catch(e){return fail(mapError(e));}
  }
  private async checkProjection(tx:Tx,p:ProjectionPublication,inputKey:string) {
    const scope=p.expectedAuthority.scope.id;
    const authority=await tx.get(key('pairing-authority','household',scope));
    if(!authority || authority.scope.kind!=='household' || authority.scope.id!==scope || authority.revision<p.nextAuthority.revision || (authority.revision===p.nextAuthority.revision && JSON.stringify(projectionCanonical(authority))!==JSON.stringify(projectionCanonical(p.nextAuthority)))) return corrupt();
    if(p.policySeed){const sidecar=await tx.get(key('projection-policy-seed',scope,p.documents[0]?.documentId));if(!sidecar||JSON.stringify(projectionCanonical(sidecar))!==JSON.stringify(projectionCanonical(p.policySeed)))return corrupt()}
    if(p.seed){const documentId=p.documents[0]?.documentId,seed=await tx.get(key('projection-seed',scope,documentId));if(!seed||JSON.stringify(projectionCanonical(seed))!==JSON.stringify(projectionCanonical(p.seed)))return corrupt();for(const x of p.seed.identities)if(await tx.get(key('projection-seed-command',scope,documentId,x.commandId))!==p.seed.seedId||await tx.get(key('projection-seed-effect',scope,documentId,x.effectId))!==p.seed.seedId)return corrupt();}
    if(p.recovery && await tx.get(key('recovery-challenge-consumed',scope,p.recovery.claimHash))!==inputKey)return corrupt();
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
  private async requireSealedFilePublication(tx:Tx,expectedAuthority:LocalCommit['expectedAuthority'],operationId:string,recipientDevice:string){await this.requireAuthority(tx,expectedAuthority);const scope=expectedAuthority.scope.id,old=await tx.get(key('projection-publication',scope,operationId));if(!old||old.input.expectedAuthority.scope.id!==scope||old.input.operationId!==operationId||old.input.nextAuthority.acceptedParent!==expectedAuthority.record?.acceptedParent||!old.input.packages.some((p:any)=>p.recipientDevice===recipientDevice))conflict();await this.checkProjection(tx,old.input,old.inputKey)}
  async readHouseholdSealedFile(expectedAuthority:LocalCommit['expectedAuthority'],operationId:string,recipientDevice:string){expectedAuthority=snapshot(expectedAuthority);if(!validId(operationId)||!validId(recipientDevice))return fail('MALFORMED');try{return await this.run(false,async tx=>{await this.requireSealedFilePublication(tx,expectedAuthority,operationId,recipientDevice);return {ok:true as const,value:snapshot((await tx.get(key('household-sealed-file',expectedAuthority.scope.id,operationId,recipientDevice)))??null)}})}catch(e){return fail(mapError(e))}}
  async commitHouseholdSealedFile(expectedAuthority:LocalCommit['expectedAuthority'],operationId:string,recipientDevice:string,record:any){expectedAuthority=snapshot(expectedAuthority);record=snapshot(record);if(!validId(operationId)||!validId(recipientDevice)||!fields(record,['version','digest','bytes','signature'])||record.version!==1||typeof record.digest!=='string'||!/^[0-9a-f]{64}$/.test(record.digest)||!(record.bytes instanceof Uint8Array)||record.bytes.length<48||record.bytes.length>16*1024*1024+48||!(record.signature instanceof Uint8Array)||record.signature.length!==64)return fail('MALFORMED');try{return await this.run(true,async tx=>{await this.requireSealedFilePublication(tx,expectedAuthority,operationId,recipientDevice);const slot=key('household-sealed-file',expectedAuthority.scope.id,operationId,recipientDevice),old=await tx.get(slot);if(old!==undefined){if(old.digest!==record.digest)conflict();return {ok:true as const,value:{record:snapshot(old),replayed:true}}}await tx.put(slot,record);return {ok:true as const,value:{record:snapshot(record),replayed:false}}})}catch(e){return fail(mapError(e))}}
  async publishProjection(input:ProjectionPublication):Promise<Result<{replayed:boolean},StorageError>> {
    const inputKey=projectionKey(input); if(inputKey===null)return {ok:false,error:'MALFORMED'}; input=snapshot(input);
    try { return await this.run(true,async tx=>{
      const scope=input.expectedAuthority.scope.id, op=key('projection-publication',scope,input.operationId), old=await tx.get(op);
      if(old) { if(old.inputKey!==inputKey) conflict(); await this.checkProjection(tx,old.input,inputKey); return {ok:true,value:{replayed:true}}; }
      for(const guard of input.guardIds ?? (input.guardId ? [input.guardId] : [])) if(await tx.get(key('pairing-guard',guard))!==undefined) conflict();
      if(input.recovery){const r=input.recovery,checked=await readContinuityHead(tx,scope,r.owner);if(checked.ok===false)return corrupt();const head=checked.value?.head,binding=checked.value?.record,challenge=await tx.get(key('recovery-readmission-challenge',scope,r.claimHash));if(!head||head.generation!==r.generation||head.bindingHash!==r.bindingHash||!binding||binding.bindingHash!==r.bindingHash||binding.binding?.owner!==r.owner||binding.binding?.generation!==r.generation||!challenge||challenge.claimHash!==r.claimHash||challenge.tokenCommitment!==r.tokenCommitment||challenge.sealed!==r.sealed||await tx.get(key('recovery-challenge-consumed',scope,r.claimHash))!==undefined)conflict();}
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
      if(input.policySeed&&await tx.get(key('projection-policy-seed',scope,input.documents[0]?.documentId))!==undefined)conflict();
      if(input.seed){if(input.documents.length!==1||await tx.get(key('projection-seed',scope,input.documents[0].documentId))!==undefined)conflict();for(const x of input.seed.identities)if(await tx.get(key('projection-seed-command',scope,input.documents[0].documentId,x.commandId))!==undefined||await tx.get(key('projection-seed-effect',scope,input.documents[0].documentId,x.effectId))!==undefined)conflict();}
      const installed=await installLocalKey(tx,input.localKey.record,input.localKey.catalog);
      if(JSON.stringify(projectionCanonical(installed.record))!==JSON.stringify(projectionCanonical(input.localKey.record))) conflict();
      await tx.put(key('projection-manifest',scope,input.manifest.id),copy(input.manifest.bytes));
      if(input.policySeed)await tx.put(key('projection-policy-seed',scope,input.documents[0].documentId),input.policySeed);
      if(input.seed){const d=input.documents[0].documentId;await tx.put(key('projection-seed',scope,d),input.seed);for(const x of input.seed.identities){await tx.put(key('projection-seed-command',scope,d,x.commandId),input.seed.seedId);await tx.put(key('projection-seed-effect',scope,d,x.effectId),input.seed.seedId);}}
      for(const d of input.documents) { await tx.put(key('document-owner',scope,d.documentId),input.nextAuthority.acceptedParent); await tx.put(key('document',scope,d.documentId),{bytes:copy(d.bytes),revision:0}); await tx.put(key('projection-document',scope,d.documentId),{generation:d.generation,operationId:input.operationId}); }
      for(const p of input.packages) { await tx.put(key('projection-package',scope,p.id),copy(p.bytes)); await tx.put(key('projection-outbox',scope,input.operationId,p.id),{packageId:p.id,recipientDevice:p.recipientDevice}); }
      for(const p of input.pendingEdits) await tx.put(key('projection-pending',scope,input.operationId,p.scopeId,p.operationId),inputKey);
      for(const guard of input.guardIds ?? (input.guardId ? [input.guardId] : [])) await tx.put(key('pairing-guard',guard),inputKey);
      if(input.recovery)await tx.put(key('recovery-challenge-consumed',scope,input.recovery.claimHash),inputKey);
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
  /** Caller verifies the signed personal admission and possession evidence before entry. */
  async commitPersonalAdmissionRelease(r:PairingRelease,next:PairingAuthorityRecord):Promise<PairingReleaseResult> {
    const checked=pairingReleaseKey(r), valid=validatePairingAuthority(next); if(!checked.ok||!valid.ok||r.transcript.action!=='pairOwnDevice'||r.transcript.scope.kind!=='personal'||next.scope.kind!=='personal'||next.scope.id!==r.transcript.scope.id||next.revision!==r.expectedAuthorityRevision+1||next.acceptedParent!==r.transcript.acceptedParent)return fail('MALFORMED');r=snapshot(r);next=snapshot(next);
    try{return await this.run(true,async tx=>{const s=r.transcript.scope,op=key('pairing-release',s.kind,s.id,r.operationId),guard=key('pairing-guard',r.guard.guardId),packet=key('pairing-packet',s.kind,s.id,r.packet.id),outbox=key('pairing-outbox',s.kind,s.id,r.operationId),transition=key('personal-admission-release',s.id,r.operationId),authorityKey=key('pairing-authority',s.kind,s.id),old=await tx.get(op),authority=await tx.get(authorityKey),binding=JSON.stringify(projectionCanonical(next));
      if(old!==undefined){if(old.inputKey!==checked.value||await tx.get(transition)!==binding||!authority||JSON.stringify(projectionCanonical(authority))!==binding)conflict();await this.pairingComplete(tx,old.release,old.inputKey);return {ok:true,value:{release:snapshot(old.release),replayed:true}};}
      if(authority&&(authority.scope.kind!==s.kind||authority.scope.id!==s.id))corrupt();
      if(!authority||authority.revision!==r.expectedAuthorityRevision||authority.acceptedParent!==r.transcript.acceptedParent||authority.authorizationSnapshot!==r.transcript.authorizationSnapshot||await tx.get(guard)!==undefined||await tx.get(packet)!==undefined||await tx.get(outbox)!==undefined||await tx.get(transition)!==undefined)conflict();
      for(const [k,v] of [[guard,checked.value],[packet,checked.value],[outbox,checked.value],[op,{inputKey:checked.value,release:r}],[transition,binding],[authorityKey,next]] as const){await tx.put(k,v);this.fault?.('personal-admission-release');}return {ok:true,value:{release:snapshot(r),replayed:false}};
    });}catch(e){return fail(mapError(e))}
  }
  private async requireIncomingAuthor(tx: Tx, scopeId: string, authorDevice: string) {
    if (!validId(authorDevice)) throw new StorageFailure('MALFORMED');
    if (await readLocalQuarantine(tx,scopeId,authorDevice)) throw new StorageFailure('QUARANTINED');
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
    for(const command of c.commands)await this.requireUnusedProjectionIdentity(tx,c.scopeId,command);
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
  private async completedImport(tx:Tx,c:ImportCommit,inputKey:string) {
    if(await tx.get(key('applied',c.scopeId,c.itemId))!==c.operationId||await tx.get(key('inbox',c.scopeId,c.itemId))===undefined)conflict();
    for(const command of c.commands)if(await tx.get(key('command',c.scopeId,command.commandId))!==inputKey||await tx.get(key('effect',c.scopeId,command.effectId))!==inputKey)conflict();
  }
  private async completedGroup(tx:Tx,g:LocalCommitGroup,old:any,inputKey:string) {
    if(old.inputKey!==inputKey||!Array.isArray(old.outcomes)||old.outcomes.length!==g.children.length)conflict();
    for(let i=0;i<g.children.length;i++){const c=g.children[i],ck=storageOperationKey(c,'local');if(!ck.ok)throw new StorageFailure(ck.error);const operation=await tx.get(key('local',c.scopeId,c.operationId));if(!operation||operation.inputKey!==ck.value||!operation.outcome)conflict();validateOutcome(operation.outcome,c.documents);validateOutcome(old.outcomes[i],c.documents);if(JSON.stringify(old.outcomes[i])!==JSON.stringify(operation.outcome))corrupt();await this.completedLocal(tx,c,ck.value)}
  }
  private async documents(tx: Tx, scope: string, docs: LocalCommit['documents'], owner: string | null): Promise<SavedOutcome> {
    const revisions: {documentId:string;revision:number}[] = [];
    for (const d of docs) {
      const old = await tx.get(key('document',scope,d.documentId));
      const oldOwner=await tx.get(key('document-owner',scope,d.documentId));
      if (owner && isPolicyDocumentId(d.documentId) && (!old || !await tx.get(key('policy-checkout-parent',scope,d.documentId)))) throw new StorageFailure('CHECKOUT_REQUIRED');
      if (owner && old && oldOwner!==owner) throw new StorageFailure('CHECKOUT_REQUIRED');
      if (owner && !old && oldOwner!==undefined) return corrupt();
      if ((old === undefined ? null : old.revision) !== d.expectedRevision || old?.revision === Number.MAX_SAFE_INTEGER) conflict();
      revisions.push({documentId:d.documentId,revision:old === undefined ? 0 : old.revision + 1});
    }
    for (let i=0;i<docs.length;i++) { if (owner && docs[i].expectedRevision===null) await tx.put(key('document-owner',scope,docs[i].documentId),owner); await tx.put(key('document',scope,docs[i].documentId), {bytes:copy(docs[i].bytes),revision:revisions[i].revision}); }
    return {state:'saved',revisions};
  }
  private async requireUnusedProjectionIdentity(tx:Tx,scope:string,command:LocalCommit['commands'][number]) {
    const origin=await this.projectionOrigin(tx,scope,command.documentId);
    if(await tx.get(key('projection-seed-command',scope,origin.documentId,command.commandId))!==undefined||
      await tx.get(key('projection-seed-effect',scope,origin.documentId,command.effectId))!==undefined) conflict();
  }
  /** Dependencies are scope-local and must precede their consumer in the transaction. */
  private async requireDependencies(tx:Tx,scopeId:string,commands:readonly {documentId:string;effectId:string;dependencyEffectIds:readonly string[]}[]) {
    const prior=new Set<string>();
    for(const command of commands) {
      for(const dep of command.dependencyEffectIds) if(!prior.has(dep) && await tx.get(key('effect',scopeId,dep))===undefined) {
        const origin=await this.projectionOrigin(tx,scopeId,command.documentId);
        if(await tx.get(key('projection-seed-effect',scopeId,origin.documentId,dep))===undefined) conflict();
      }
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
  async listDisclosurePending(scopeId:string) { try{return await this.run(false,async tx=>{const result:any[]=[];for(const raw of await tx.keys()){let k:any;try{k=JSON.parse(raw)}catch{continue}if(Array.isArray(k)&&k.length===3&&k[0]==='disclosure-pending'&&k[1]===scopeId){const v=await tx.get(raw);if(v.objectId!==k[2]||!await tx.get(key('inbox',scopeId,k[2])))corrupt();if(await tx.get(key('applied',scopeId,k[2]))===undefined)result.push(snapshot(v))}}return {ok:true as const,value:result}})}catch(e){return fail(mapError(e))} }
  async markDisclosurePending(expectedAuthority:LocalCommit['expectedAuthority'],objectId:string,bytes:Uint8Array,authorDevice:string) {
    if(!expectedAuthority||!validId(objectId)||!(bytes instanceof Uint8Array))return fail('MALFORMED');expectedAuthority=snapshot(expectedAuthority);bytes=copy(bytes);
    try{return await this.run(true,async tx=>{await this.requireAuthority(tx,expectedAuthority);const scope=expectedAuthority.scope.id,inbox=await tx.get(key('inbox',scope,objectId));if(expectedAuthority.scope.kind!=='household'||!inbox||!sameBytes(inbox.bytes,bytes)||await tx.get(key('applied',scope,objectId))!==undefined)conflict();await this.requireIncomingAuthor(tx,scope,authorDevice);await tx.put(key('disclosure-pending',scope,objectId),{objectId,reason:'POLICY_GOVERNANCE_UNPROVEN'});return {ok:true as const,value:undefined}})}catch(e){return fail(mapError(e))}
  }
  async readDisclosureReview(scopeId:string,id:string) {try{return await this.run(false,async tx=>({ok:true as const,value:snapshot((await tx.get(key('disclosure-review',scopeId,id)))??null)}))}catch(e){return {ok:false as const,error:mapError(e)}}}
  async saveDisclosureReview(input:any) {
    input=snapshot(input);if(!fields(input,['expectedAuthority','policyHash','documentId','documentRevision','record'])||!validId(input.policyHash)||!validId(input.documentId)||!revision(input.documentRevision)||!object(input.record)||!validId(input.record.id))return fail('MALFORMED');
    try{return await this.run(true,async tx=>{await this.requireAuthority(tx,input.expectedAuthority);const scope=input.expectedAuthority.scope.id,head=input.expectedAuthority.record?.acceptedParent;if(input.expectedAuthority.scope.kind!=='household'||input.record.scopeId!==scope||input.record.checkpoint!==head||input.record.currentPolicyHash!==input.policyHash||input.record.documentId!==input.documentId||input.record.documentRevision!==input.documentRevision||(await tx.get(key('disclosure-active',scope)))!==input.policyHash)conflict();const doc=await tx.get(key('document',scope,input.documentId)),owner=await tx.get(key('document-owner',scope,input.documentId));if(!doc||doc.revision!==input.documentRevision||owner!==head)conflict();const slot=key('disclosure-review',scope,input.record.id);if(await tx.get(slot)!==undefined)conflict();await tx.put(slot,{record:input.record,state:'reviewed',context:{expectedAuthority:input.expectedAuthority,policyHash:input.policyHash,documentId:input.documentId,documentRevision:input.documentRevision}});this.fault?.('disclosure-review');return {ok:true as const,value:undefined}})}catch(e){return fail(mapError(e))}
  }
  async transitionDisclosureReview(input:any) {
    input=snapshot(input);if(!fields(input,['expectedAuthority','policyHash','documentId','documentRevision','reviewId','from','to'])||!validId(input.policyHash)||!validId(input.documentId)||!revision(input.documentRevision)||!validId(input.reviewId)||!((input.from==='reviewed'&&input.to==='unknown')||(input.from==='unknown'&&['sent','failed'].includes(input.to))))return fail('MALFORMED');
    try{return await this.run(true,async tx=>{const scope=input.expectedAuthority.scope.id,slot=key('disclosure-review',scope,input.reviewId),stored=await tx.get(slot);if(!stored||stored.state!==input.from||!stored.context||stored.context.policyHash!==input.policyHash||stored.context.documentId!==input.documentId||stored.context.documentRevision!==input.documentRevision||JSON.stringify(projectionCanonical(stored.context.expectedAuthority))!==JSON.stringify(projectionCanonical(input.expectedAuthority)))conflict();if(input.from==='reviewed'){await this.requireAuthority(tx,input.expectedAuthority);const head=input.expectedAuthority.record?.acceptedParent,doc=await tx.get(key('document',scope,input.documentId)),owner=await tx.get(key('document-owner',scope,input.documentId));if((await tx.get(key('disclosure-active',scope)))!==input.policyHash||!doc||doc.revision!==input.documentRevision||owner!==head||stored.record.checkpoint!==head)conflict()}await tx.put(slot,{record:stored.record,state:input.to,context:stored.context});this.fault?.('disclosure-transition');return {ok:true as const,value:undefined}})}catch(e){return fail(mapError(e))}
  }
  async readDisclosureActive(scopeId:string) {
    try{return await this.run(false,async tx=>{
      const active=(await tx.get(key('disclosure-active',scopeId)))??null;
      const authority=await tx.get(key('pairing-authority','household',scopeId));
      for(const raw of await tx.keys()){
        let parts:any;try{parts=JSON.parse(raw)}catch{continue}
        if(!Array.isArray(parts)||parts.length!==3||parts[0]!=='disclosure-policy'||parts[1]!==scopeId)continue;
        const record=await tx.get(raw);
        if(record.policyHash!==parts[2])corrupt();
        const checkpoint=record.policy?.checkpoint;
        if(validId(checkpoint)&&checkpoint!==authority?.acceptedParent&&await tx.get(key('policy-disclosure-head',scopeId,checkpoint))!==undefined)continue;
        if(record.policy?.predecessor===active&&record.policyHash!==active)conflict();
      }
      return {ok:true as const,value:active};
    })}catch(e){return {ok:false as const,error:mapError(e)}}
  }
  async readArchivedDisclosurePolicy(scopeId:string,policyHash:string) {try{return await this.run(false,async tx=>({ok:true as const,value:snapshot((await tx.get(key('disclosure-policy-archive',scopeId,policyHash))) ?? null)}))}catch(e){return {ok:false as const,error:mapError(e)}}}
  async readDisclosurePolicy(scopeId:string,policyHash:string) {try{return await this.run(false,async tx=>({ok:true as const,value:snapshot((await tx.get(key('disclosure-policy',scopeId,policyHash))) ?? null)}))}catch(e){return {ok:false as const,error:mapError(e)}}}
  private async validatedDisclosureSource(tx:Tx,scopeId:string,effectId:string,governingPolicyHash?:string|null) {
    const source=await tx.get(key('disclosure-source',scopeId,effectId));if(!source)return null;
    const inputKey=await tx.get(key('effect',scopeId,effectId));let parsed:any,envelope:any;try{parsed=JSON.parse(inputKey);envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(source.envelope))}catch{return corrupt()}
    if(!Array.isArray(parsed)||parsed.length!==2||!object(parsed[1])||parsed[1].scopeId!==scopeId||!Array.isArray(parsed[1].commands))return corrupt();const command=parsed[1].commands.find((c:any)=>c.effectId===effectId&&c.commandId===source.commandId&&c.documentId===source.documentId),h=envelope?.header;
    if(!command||await tx.get(key('command',scopeId,source.commandId))!==inputKey||![2,3,4].includes(h?.version)||(h.version===3||h.version===4&&h.disclosureIncomplete===true)!==(source.incomplete===true)||(h.version===3&&h.disclosureIncomplete!==true||h.version===4&&typeof h.disclosureIncomplete!=='boolean')||h.scopeId!==scopeId||h.documentId!==source.documentId||h.branchHead!==source.checkpoint||JSON.stringify(h.semanticEffectIds)!==JSON.stringify([effectId])||JSON.stringify(h.sourceEffectIds)!==JSON.stringify([...command.dependencyEffectIds].sort())||JSON.stringify(h.disclosurePolicyHashes)!==JSON.stringify(source.policyHashes)||(h.disclosurePolicyHash!==null&&!source.policyHashes.includes(h.disclosurePolicyHash)))return corrupt();
    if(governingPolicyHash!==undefined&&h.disclosurePolicyHash!==governingPolicyHash)conflict();
    const operation=parsed[1].operationId;if(source.origin==='local'){const local=await tx.get(key('local',scopeId,operation)),objectRecord=await tx.get(key('object',scopeId,source.objectId));if(parsed[0]!=='local'||!local||local.inputKey!==inputKey||!objectRecord||!sameBytes(objectRecord.bytes,source.envelope)||!parsed[1].outbound?.some((entry:any)=>entry.object?.id===source.objectId&&JSON.stringify(entry.object.bytes)===JSON.stringify(Array.from(source.envelope))))return corrupt()}else{const applied=await tx.get(key('applied',scopeId,source.objectId)),old=await tx.get(key('import',scopeId,operation)),inbox=await tx.get(key('inbox',scopeId,source.objectId));if(parsed[0]!=='import'||parsed[1].itemId!==source.objectId||applied!==operation||!old||old.inputKey!==inputKey||!inbox||!sameBytes(inbox.bytes,source.envelope))return corrupt()}return source;
  }
  private async disclosureDependency(tx:Tx,scope:string,documentId:string,effectId:string,visiting=new Set<string>()):Promise<{policyHashes:string[],incomplete:boolean}>{
    if(visiting.has(effectId)||visiting.size>=256)corrupt();visiting.add(effectId);const source=await this.validatedDisclosureSource(tx,scope,effectId);if(source)return {policyHashes:source.policyHashes,incomplete:source.incomplete===true};
    const lineage=await this.projectionLineage(tx,scope,documentId),origin=lineage.at(-1)!;
    const old=await tx.get(key('effect',scope,effectId)),seedId=await tx.get(key('projection-seed-effect',scope,origin.documentId,effectId));if(old===undefined&&seedId===undefined)conflict();let hashes:string[]=[];
    if(old!==undefined){let parsed:any;try{parsed=JSON.parse(old)}catch{return corrupt()}const command=parsed?.[1]?.commands?.find((c:any)=>c.effectId===effectId&&lineage.some(branch=>branch.documentId===c.documentId));if(!command||await tx.get(key('command',scope,command.commandId))!==old||!denseArray(command.dependencyEffectIds,validId))return corrupt();const inherited=new Set<string>();for(const dep of command.dependencyEffectIds){const parent=await this.disclosureDependency(tx,scope,documentId,dep,new Set(visiting));for(const h of parent.policyHashes)inherited.add(h)}hashes=[...inherited].sort()}
    if(seedId!==undefined){const sidecar=await tx.get(key('projection-policy-seed',scope,origin.documentId));if(sidecar!==undefined){if(sidecar.bundle?.scopeId!==scope||sidecar.bundle?.seedId!==seedId||!Array.isArray(sidecar.bundle?.entries))return corrupt();const matching=sidecar.bundle.entries.filter((x:any)=>x.effectId===effectId);if(matching.length!==1||!denseArray(matching[0].policyHashes,validId))return corrupt();hashes=matching[0].policyHashes}}
    return {policyHashes:hashes,incomplete:true};
  }
  async readDisclosureSource(scopeId:string,effectId:string) {try{return await this.run(false,async tx=>({ok:true as const,value:snapshot(await this.validatedDisclosureSource(tx,scopeId,effectId))}))}catch(e){return {ok:false as const,error:mapError(e)}}}
  /** Legacy envelopes authenticate edits but carry no disclosure policy evidence. */
  async readLegacyCookingSource(expectedAuthority:AuthorityExpectation,effectId:string) {
    if(expectedAuthority?.scope?.kind!=='household'||!validId(effectId))return fail('MALFORMED');
    try{return await this.run(false,async tx=>{
      await this.requireAuthority(tx,expectedAuthority);
      const scope=expectedAuthority.scope.id,inputKey=await tx.get(key('effect',scope,effectId));
      if(inputKey===undefined)return {ok:true as const,value:null};
      let parsed:any;
      try{parsed=JSON.parse(inputKey)}catch{return corrupt();}
      let objectId:string,envelope:Uint8Array,command:LocalCommit['commands'][number]|undefined;
      if(parsed?.[0]==='local') {
        const saved=await this.localOperation(tx,scope,parsed[1]?.operationId);
        if(!saved)return corrupt();
        const index=saved.commit.commands.findIndex(c=>c.effectId===effectId);
        command=saved.commit.commands[index];
        const entry=saved.commit.outbound[index];
        if(!entry)return corrupt();
        ({id:objectId,bytes:envelope}=entry.object);
      } else if(parsed?.[0]==='import') {
        objectId=parsed[1]?.itemId;
        const saved=await this.importedOperation(tx,scope,objectId);
        command=saved?.commit.commands.find(c=>c.effectId===effectId);
        envelope=(await tx.get(key('inbox',scope,objectId)))?.bytes;
      } else return corrupt();
      if(!command||!(envelope instanceof Uint8Array))return corrupt();
      let header:any;
      try{header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(envelope)).header}catch{return corrupt();}
      if(header?.version!==1||header.scopeId!==scope||header.documentId!==command.documentId||!validId(header.branchHead))return corrupt();
      return {ok:true as const,value:{checkpoint:header.branchHead,documentId:command.documentId,commandId:command.commandId,objectId,envelope:copy(envelope),policyHashes:[]}};
    })}catch(e){return fail(mapError(e))}
  }
  async publishDisclosurePolicy(input:any) {
    input=snapshot(input);if(!fields(input,['expectedAuthority','expectedPolicyHash','record'])||!fields(input.record,['policy','policyHash','approvals'])||!validId(input.record.policyHash)||!(input.expectedPolicyHash===null||validId(input.expectedPolicyHash)))return fail('MALFORMED');
    try{return await this.run(true,async tx=>{await this.requireAuthority(tx,input.expectedAuthority);const scope=input.expectedAuthority.scope.id,head=input.expectedAuthority.record?.acceptedParent;if(input.expectedAuthority.scope.kind!=='household'||input.record.policy?.scope?.id!==scope||input.record.policy?.checkpoint!==head||input.record.policy?.predecessor!==input.expectedPolicyHash)conflict();const active=(await tx.get(key('disclosure-active',scope)))??null;if(active!==input.expectedPolicyHash)conflict();const slot=key('disclosure-policy',scope,input.record.policyHash);if(await tx.get(slot)!==undefined)conflict();await tx.put(slot,input.record);this.fault?.('disclosure-policy');await tx.put(key('disclosure-active',scope),input.record.policyHash);return {ok:true as const,value:undefined}})}catch(e){return fail(mapError(e))}
  }
  async commitLocalWithDisclosurePolicy(c:LocalCommit,policyHash:string|null,expectedActiveHash:string|null=policyHash):Promise<CommitResult> {
    const k=storageOperationKey(c,'local');if(!k.ok)return fail(k.error);if((policyHash!==null&&!validId(policyHash))||(expectedActiveHash!==null&&!validId(expectedActiveHash))||(policyHash!==null&&policyHash!==expectedActiveHash))return fail('MALFORMED');c=snapshot(c);
    if(c.commands.length!==c.outbound.length)return fail('MALFORMED');
    const allowed=new Set(['recipe-create','recipe-field','recipe-ingredient-add','recipe-ingredient-field','recipe-step-add','recipe-step-field','pantry-create','pantry-field','shopping-list-create','shopping-cycle-start','shopping-item-put','shopping-item-create','shopping-item-field','shopping-list-field','purchase','purchase-correction']);if(c.expectedAuthority.scope.kind!=='household'||c.commands.some(command=>!allowed.has(command.kind)))return fail('MALFORMED');
    try{return await this.run(true,async tx=>{const scope=c.scopeId,head=c.expectedAuthority.record?.acceptedParent;const old=await tx.get(key('local',scope,c.operationId));if(old){if(old.inputKey!==k.value)conflict();for(const command of c.commands){const source=await this.validatedDisclosureSource(tx,scope,command.effectId,policyHash);if(!source||source.commandId!==command.commandId||source.documentId!==command.documentId)conflict()}validateOutcome(old.outcome,c.documents);await this.completedLocal(tx,c,k.value);return {ok:true as const,value:{outcome:old.outcome,replayed:true}}}
      await this.requireAuthority(tx,c.expectedAuthority);if(((await tx.get(key('disclosure-active',scope)))??null)!==expectedActiveHash)conflict();if(expectedActiveHash!==null){const policy=await tx.get(key('disclosure-policy',scope,expectedActiveHash));if(!policy||policy.policyHash!==expectedActiveHash||policy.policy?.scope?.id!==scope||(policyHash!==null&&policy.policy?.checkpoint!==head))conflict()}
      const sources=new Map<string,any>();for(const command of c.commands){const policies=new Set<string>(policyHash===null?[]:[policyHash]);let incomplete=policyHash===null;for(const dep of command.dependencyEffectIds){const parent=sources.get(dep)??await this.disclosureDependency(tx,scope,command.documentId,dep);incomplete||=parent.incomplete===true;for(const hash of parent.policyHashes)policies.add(hash)}const envelopeBytes=c.outbound[sources.size].object.bytes;let header:any;try{header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(envelopeBytes))?.header}catch{conflict()}if(incomplete&&!(header?.version===3||header?.version===4&&header.disclosureIncomplete===true))conflict();const source={policyHashes:[...policies].sort(),checkpoint:head,documentId:command.documentId,commandId:command.commandId,envelope:envelopeBytes,origin:'local',objectId:c.outbound[sources.size].object.id,...(header?.version===3||header?.version===4&&header.disclosureIncomplete===true?{incomplete:true}:{})};let envelope:any;try{envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(c.outbound[sources.size].object.bytes))}catch{conflict()}const h=envelope?.header;if((['shopping-item-create','shopping-item-field','shopping-list-field'].includes(command.kind)&&h?.version!==4)||![2,3,4].includes(h?.version)||(h.version===3&&h.disclosureIncomplete!==true||h.version===4&&typeof h.disclosureIncomplete!=='boolean')||h.disclosurePolicyHash!==policyHash||h.scopeId!==scope||h.documentId!==command.documentId||h.branchHead!==head||JSON.stringify(h.semanticEffectIds)!==JSON.stringify([command.effectId])||JSON.stringify(h.sourceEffectIds)!==JSON.stringify([...command.dependencyEffectIds].sort())||JSON.stringify(h.disclosurePolicyHashes)!==JSON.stringify(source.policyHashes))conflict();sources.set(command.effectId,source)}
      const outcome=await this.local(tx,c,k.value);this.fault?.('disclosure-local');for(const [effectId,source] of sources)await tx.put(key('disclosure-source',scope,effectId),source);return {ok:true as const,value:{outcome,replayed:false}}})}catch(e){return fail(mapError(e))}
  }
  async commitLocal(c: LocalCommit): Promise<CommitResult> {
    const k = storageOperationKey(c,'local'); if (!k.ok) return fail(k.error); if(c.commands.some(x=>['shopping-item-create','shopping-item-field','shopping-list-field'].includes(x.kind)))return fail('MALFORMED'); c = snapshot(c);
    try { return await this.run(true, async tx => {
      const old = await tx.get(key('local',c.scopeId,c.operationId));
      if (old !== undefined) { if (old.inputKey !== k.value || !old.outcome) conflict(); validateOutcome(old.outcome,c.documents); await this.completedLocal(tx,c,k.value); return {ok:true,value:{outcome:old.outcome,replayed:true}}; }
      await this.requireAuthority(tx,c.expectedAuthority);
      const outcome = await this.local(tx,c,k.value); this.fault?.('local');
      return {ok:true,value:{outcome,replayed:false}};
    }); } catch (e) { return fail(mapError(e)); }
  }
  /** Distinct household documents commit together with signed provenance. */
  async commitLocalGroupWithDisclosurePolicy(g:LocalCommitGroup,policyHash:string|null,expectedActiveHash:string|null=policyHash):Promise<GroupCommitResult> {
    const groupKey=storageGroupKey(g);if(!groupKey.ok)return fail(groupKey.error);if((policyHash!==null&&!validId(policyHash))||(expectedActiveHash!==null&&!validId(expectedActiveHash))||(policyHash!==null&&policyHash!==expectedActiveHash))return fail('MALFORMED');g=snapshot(g);
    const allowed=new Set(['recipe-create','recipe-field','recipe-ingredient-add','recipe-ingredient-field','recipe-step-add','recipe-step-field','pantry-create','pantry-field','shopping-list-create','shopping-cycle-start','shopping-item-put','shopping-item-create','shopping-item-field','shopping-list-field','purchase','purchase-correction']);
    const scope=g.children[0].scopeId;if(g.children.some(c=>c.scopeId!==scope||c.expectedAuthority.scope.kind!=='household'||c.commands.length!==c.outbound.length||c.commands.some(x=>!allowed.has(x.kind))))return fail('MALFORMED');
    try{return await this.run(true,async tx=>{const old=await tx.get(key('group',g.groupId));if(old!==undefined){await this.completedGroup(tx,g,old,groupKey.value);for(const c of g.children)for(const command of c.commands){const source=await this.validatedDisclosureSource(tx,scope,command.effectId,policyHash);if(!source||source.commandId!==command.commandId)conflict()}return {ok:true as const,value:{outcomes:old.outcomes,replayed:true}}}
      const staged=new Map<string,any>();for(const c of g.children){await this.requireAuthority(tx,c.expectedAuthority);await this.identities(tx,c);const head=c.expectedAuthority.record?.acceptedParent;if(((await tx.get(key('disclosure-active',scope)))??null)!==expectedActiveHash)conflict();if(expectedActiveHash!==null){const policy=await tx.get(key('disclosure-policy',scope,expectedActiveHash));if(!policy||policy.policyHash!==expectedActiveHash||policy.policy?.scope?.id!==scope||(policyHash!==null&&policy.policy?.checkpoint!==head))conflict()}for(let i=0;i<c.commands.length;i++){const command=c.commands[i],policies=new Set<string>(policyHash===null?[]:[policyHash]);let incomplete=policyHash===null;for(const dep of command.dependencyEffectIds){const parent=staged.get(dep)??await this.disclosureDependency(tx,scope,command.documentId,dep);incomplete||=parent.incomplete===true;for(const h of parent.policyHashes)policies.add(h)}let header:any;try{header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(c.outbound[i].object.bytes))?.header}catch{conflict()}if(incomplete&&!(header?.version===3||header?.version===4&&header.disclosureIncomplete===true))conflict();const source={policyHashes:[...policies].sort(),checkpoint:head,documentId:command.documentId,commandId:command.commandId,envelope:c.outbound[i].object.bytes,origin:'local',objectId:c.outbound[i].object.id,...(header?.version===3||header?.version===4&&header.disclosureIncomplete===true?{incomplete:true}:{})};let envelope:any;try{envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(source.envelope))}catch{conflict()}const h=envelope?.header;if((['shopping-item-create','shopping-item-field','shopping-list-field'].includes(command.kind)&&h?.version!==4)||![2,3,4].includes(h?.version)||(h.version===3&&h.disclosureIncomplete!==true||h.version===4&&typeof h.disclosureIncomplete!=='boolean')||h.disclosurePolicyHash!==policyHash||h.scopeId!==scope||h.documentId!==command.documentId||h.branchHead!==head||JSON.stringify(h.semanticEffectIds)!==JSON.stringify([command.effectId])||JSON.stringify(h.sourceEffectIds)!==JSON.stringify([...command.dependencyEffectIds].sort())||JSON.stringify(h.disclosurePolicyHashes)!==JSON.stringify(source.policyHashes))conflict();staged.set(command.effectId,source)}}
      const outcomes:SavedOutcome[]=[];for(const c of g.children){const ck=storageOperationKey(c,'local');if(!ck.ok)throw new StorageFailure(ck.error);outcomes.push(await this.local(tx,c,ck.value));this.fault?.('child')}for(const [effect,source] of staged)await tx.put(key('disclosure-source',scope,effect),source);await tx.put(key('group',g.groupId),{inputKey:groupKey.value,outcomes});this.fault?.('group');return {ok:true as const,value:{outcomes,replayed:false}}})}catch(e){return fail(mapError(e))}
  }
  async commitLocalGroup(g: LocalCommitGroup): Promise<GroupCommitResult> {
    const k = storageGroupKey(g); if (!k.ok) return fail(k.error); if(g.children.some(c=>c.commands.some(x=>['shopping-item-create','shopping-item-field','shopping-list-field'].includes(x.kind))))return fail('MALFORMED'); g = snapshot(g);
    try { return await this.run(true, async tx => {
      const old = await tx.get(key('group',g.groupId));
      if (old !== undefined) { await this.completedGroup(tx,g,old,k.value); return {ok:true,value:{outcomes:old.outcomes,replayed:true}}; }
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
      if(isPolicyDocumentId(documentId) && (!doc || !await tx.get(key('policy-checkout-parent',scope,documentId)))) throw new StorageFailure('CHECKOUT_REQUIRED');
      if (!doc) { if(owner!==undefined) return corrupt(); return {ok:true,value:null}; }
      if (owner!==expectedAuthority.record!.acceptedParent) throw new StorageFailure('CHECKOUT_REQUIRED');
      return {ok:true,value:{documentId,bytes:copy(doc.bytes),revision:doc.revision}};
    }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  /** Structural retained seed lookup; callers must authenticate its historical head. */
  private async readRecipientProjection(scopeId:string,operationId:string,documentId:string,head?:string){
    const store=(this as any).householdRecipient;if(!store)return null;const found=await store.find(scopeId,operationId);if(!found.ok)throw new StorageFailure('CORRUPT');if(!found.value)return null;const p=found.value,checked=await store.check(p);if(!checked.ok||p.documentId!==documentId||(head!==undefined&&p.nextAuthority.acceptedParent!==head))throw new StorageFailure('CORRUPT');return {nextAuthority:p.nextAuthority,manifest:p.manifest,documents:[{documentId:p.documentId,generation:p.generation,bytes:p.snapshot}],seed:p.seed,policySeed:p.policySeed};
  }
  async readRetainedProjectionSeed(scopeId:string,documentId:string):Promise<Result<{seed:{seedId:string;identities:{commandId:string;effectId:string}[]};snapshot:Uint8Array;head:string}|null,StorageError>> {
    if(!validId(scopeId)||!validId(documentId))return {ok:false,error:'MALFORMED'};
    try{const found=await this.run(false,async tx=>{const seed=await tx.get(key('projection-seed',scopeId,documentId)),meta=await tx.get(key('projection-document',scopeId,documentId));if(seed===undefined)return null;if(!meta||!validId(meta.operationId))return corrupt();return {seed:snapshot(seed),operationId:meta.operationId}});if(!found)return {ok:true,value:null};const p=await this.getProjectionPublication(scopeId,found.operationId);if(p.ok&&!p.value){const recipient=await this.readRecipientProjection(scopeId,found.operationId,documentId);if(recipient&&JSON.stringify(projectionCanonical(recipient.seed))===JSON.stringify(projectionCanonical(found.seed)))return {ok:true,value:{seed:found.seed,snapshot:copy(recipient.documents[0].bytes),head:recipient.nextAuthority.acceptedParent}};}if(!p.ok||!p.value||p.value.documents.length!==1||p.value.documents[0].documentId!==documentId||JSON.stringify(projectionCanonical(p.value.seed))!==JSON.stringify(projectionCanonical(found.seed)))return {ok:false,error:'CORRUPT'};return {ok:true,value:{seed:found.seed,snapshot:copy(p.value.documents[0].bytes),head:p.value.nextAuthority.acceptedParent}}}catch(e){return {ok:false,error:mapError(e)}}
  }
  private async projectionLineage(tx:Tx,scope:string,documentId:string,head?:string) {
    let current={documentId,head};
    const lineage=[current];
    for(let i=0;isPolicyDocumentId(current.documentId);i++) {
      if(i>=128 || (current.head!==undefined && current.documentId!==`policy-${current.head}`)) return corrupt();
      const parent=await tx.get(key('policy-checkout-parent',scope,current.documentId));
      if(!parent) throw new StorageFailure('CHECKOUT_REQUIRED');
      current=parent;
      lineage.push(current);
    }
    return lineage;
  }
  private async projectionOrigin(tx:Tx,scope:string,documentId:string,head?:string) {
    return (await this.projectionLineage(tx,scope,documentId,head)).at(-1)!;
  }
  async readProjectionSeed(expectedAuthority: AuthorityExpectation,documentId:string):Promise<Result<{seed:{seedId:string;identities:{commandId:string;effectId:string}[]};snapshot:Uint8Array}|null,StorageError>> {
    if(!validId(documentId))return {ok:false,error:'MALFORMED'};
    try {
      const scope=expectedAuthority.scope.id;
      const origin=await this.run(false,async tx=>{await this.requireAuthority(tx,expectedAuthority);return this.projectionOrigin(tx,scope,documentId,expectedAuthority.record?.acceptedParent)});
      const result=await this.readRetainedProjectionSeed(scope,origin.documentId);
      if(result.ok&&result.value&&result.value.head!==origin.head)return {ok:false,error:'CORRUPT'};
      return result;
    }catch(e){return {ok:false,error:mapError(e)}}
  }
  async readProjectionPolicySeed(expectedAuthority: AuthorityExpectation,documentId:string) {
    if(!validId(documentId))return fail('MALFORMED');
    try{
      const scope=expectedAuthority.scope.id;
      const found=await this.run(false,async tx=>{
        await this.requireAuthority(tx,expectedAuthority);
        const origin=await this.projectionOrigin(tx,scope,documentId,expectedAuthority.record?.acceptedParent);
        const meta=await tx.get(key('projection-document',scope,origin.documentId)),sidecar=await tx.get(key('projection-policy-seed',scope,origin.documentId));
        if(sidecar===undefined)return null;
        if(!meta||!validId(meta.operationId))return corrupt();
        return {origin,operationId:meta.operationId,sidecar:snapshot(sidecar)};
      });
      if(!found)return {ok:true as const,value:null};
      const {origin,operationId,sidecar}=found,published=await this.getProjectionPublication(scope,operationId);
      if(published.ok&&!published.value){
        const recipient=await this.readRecipientProjection(scope,operationId,origin.documentId,origin.head);
        if(recipient&&JSON.stringify(projectionCanonical(recipient.policySeed))===JSON.stringify(projectionCanonical(sidecar)))return {ok:true as const,value:{publication:recipient,policySeed:sidecar}};
      }
      if(!published.ok||!published.value||published.value.nextAuthority.acceptedParent!==origin.head||published.value.documents.length!==1||published.value.documents[0].documentId!==origin.documentId||JSON.stringify(projectionCanonical(published.value.policySeed))!==JSON.stringify(projectionCanonical(sidecar)))return fail('CORRUPT');
      return {ok:true as const,value:{publication:published.value,policySeed:sidecar}};
    }catch(e){return fail(mapError(e))}
  }
  async reopenDocument(scopeId: string, documentId: string): Promise<Result<({documentId:string;bytes:Uint8Array;revision:number}) | null,StorageError>> {
    try { return await this.run(false,async tx => { const d = await tx.get(key('document',scopeId,documentId)); return {ok:true,value:d === undefined ? null : {documentId,bytes:copy(d.bytes),revision:d.revision}}; }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  async stageInbox(item: InboxItem, expectedAuthority?:AuthorityExpectation, authorDevice?:string): Promise<Result<void,StorageError>> {
    const valid = validateInboxItem(item); if (!valid.ok) return valid; item = snapshot(item);
    if(expectedAuthority!==undefined&&(!validPairingScope(expectedAuthority?.scope)||expectedAuthority.scope.id!==item.scopeId||!expectedAuthority.record))return {ok:false,error:'MALFORMED'};
    expectedAuthority=snapshot(expectedAuthority);
    try { return await this.run(true,async tx => {
      if(expectedAuthority)await this.requireAuthority(tx,expectedAuthority);
      const cursorKey = key('cursor',item.scopeId,item.source), itemKey = key('inbox',item.scopeId,item.object.id);
      const cursor = await tx.get(cursorKey), old = await tx.get(itemKey);
      if (authorDevice !== undefined) {
        // A completed duplicate can be reported without rewriting the cursor.
        if (old && sameBytes(old.bytes,item.object.bytes) && await this.importedOperation(tx,item.scopeId,item.object.id)) {
          return {ok:true,value:undefined};
        }
        await this.requireIncomingAuthor(tx,item.scopeId,authorDevice);
      }
      if ((cursor === undefined ? null : cursor) !== item.expectedCursor || (old !== undefined && !sameBytes(old.bytes,item.object.bytes))) conflict();
      if (old === undefined) await tx.put(itemKey,{bytes:copy(item.object.bytes)});
      this.fault?.('inbox'); await tx.put(cursorKey,item.cursor); this.fault?.('cursor');
      return {ok:true,value:undefined};
    }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  async commitImportWithDisclosurePolicy(c:ImportCommit,header:any,verified:{objectId:string,bytes:Uint8Array},expectedActiveHash:string|null=header.disclosurePolicyHash):Promise<CommitResult> {
    const k=storageOperationKey(c,'import');if(!k.ok)return fail(k.error);c=snapshot(c);header=snapshot(header);verified=snapshot(verified);if(!verified||verified.objectId!==c.itemId||!(verified.bytes instanceof Uint8Array)||c.commands.length!==1||(['shopping-item-create','shopping-item-field','shopping-list-field'].includes(c.commands[0].kind)&&header?.version!==4)||!['recipe-create','recipe-field','recipe-ingredient-add','recipe-ingredient-field','recipe-step-add','recipe-step-field','pantry-create','pantry-field','shopping-list-create','shopping-cycle-start','shopping-item-put','shopping-item-create','shopping-item-field','shopping-list-field','purchase','purchase-correction'].includes(c.commands[0].kind)||c.expectedAuthority.scope.kind!=='household'||!object(header)||![2,3,4].includes(header.version)||(header.version===3&&header.disclosureIncomplete!==true||header.version===4&&typeof header.disclosureIncomplete!=='boolean')||!(validId(header.disclosurePolicyHash)||((header.version===3||header.version===4&&header.disclosureIncomplete)&&header.disclosurePolicyHash===null))||!(expectedActiveHash===null||validId(expectedActiveHash))||!denseArray(header.disclosurePolicyHashes,validId)||!denseArray(header.sourceEffectIds,validId))return fail('MALFORMED');
    try{return await this.run(true,async tx=>{const scope=c.scopeId,head=c.expectedAuthority.record?.acceptedParent,command=c.commands[0],inbox=await tx.get(key('inbox',scope,c.itemId));if(!inbox||!sameBytes(inbox.bytes,verified.bytes))conflict();let staged:any;try{staged=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(inbox.bytes))}catch{conflict()}if(JSON.stringify(staged.header)!==JSON.stringify(header))conflict();if(header.scopeId!==scope||header.documentId!==command.documentId||header.branchHead!==head||JSON.stringify(header.semanticEffectIds)!==JSON.stringify([command.effectId])||JSON.stringify(header.sourceEffectIds)!==JSON.stringify([...command.dependencyEffectIds].sort()))conflict();
      const op=key('import',scope,c.operationId),old=await tx.get(op);if(old){if(old.inputKey!==k.value||!old.outcome)conflict();await this.completedImport(tx,c,k.value);const prior=await this.validatedDisclosureSource(tx,scope,command.effectId);if(!prior||prior.commandId!==command.commandId||prior.objectId!==verified.objectId||!sameBytes(prior.envelope,verified.bytes)||JSON.stringify(prior.policyHashes)!==JSON.stringify(header.disclosurePolicyHashes))conflict();validateOutcome(old.outcome,c.documents);return {ok:true as const,value:{outcome:old.outcome,replayed:true}}}
      await this.requireAuthority(tx,c.expectedAuthority);await this.requireIncomingAuthor(tx,scope,header.authorDevice);if(await tx.get(key('applied',scope,c.itemId))!==undefined)conflict();if(((await tx.get(key('disclosure-active',scope)))??null)!==expectedActiveHash)conflict();if((header.version===2||header.version===4&&!header.disclosureIncomplete)&&expectedActiveHash!==header.disclosurePolicyHash)conflict();if(expectedActiveHash!==null){const activePolicy=await tx.get(key('disclosure-policy',scope,expectedActiveHash));if(!activePolicy||activePolicy.policyHash!==expectedActiveHash||activePolicy.policy?.scope?.id!==scope||((header.version===2||header.version===4&&!header.disclosureIncomplete)&&activePolicy.policy?.checkpoint!==head))conflict()}
      const policies=new Set<string>(header.disclosurePolicyHash===null?[]:[header.disclosurePolicyHash]);let incomplete=header.disclosurePolicyHash===null;for(const dep of command.dependencyEffectIds){const parent=await this.disclosureDependency(tx,scope,command.documentId,dep);incomplete||=parent.incomplete===true;for(const h of parent.policyHashes)policies.add(h)}if(incomplete&&!(header.version===3||header.version===4&&header.disclosureIncomplete===true))conflict();const source={policyHashes:[...policies].sort(),checkpoint:head,documentId:command.documentId,commandId:command.commandId,envelope:inbox.bytes,origin:'import',objectId:c.itemId,...(header.version===3||header.version===4&&header.disclosureIncomplete===true?{incomplete:true}:{})};if(JSON.stringify(source.policyHashes)!==JSON.stringify(header.disclosurePolicyHashes))conflict();
      if(await tx.get(key('command',scope,command.commandId))!==undefined||await tx.get(key('effect',scope,command.effectId))!==undefined)conflict();await this.requireUnusedProjectionIdentity(tx,scope,command);await this.requireDependencies(tx,scope,c.commands);const outcome=await this.documents(tx,scope,c.documents,head??null);this.fault?.('import-documents');await tx.put(key('command',scope,command.commandId),k.value);await tx.put(key('effect',scope,command.effectId),k.value);await tx.put(key('disclosure-source',scope,command.effectId),source);await tx.put(key('applied',scope,c.itemId),c.operationId);await tx.put(op,{inputKey:k.value,outcome});this.fault?.('import');return {ok:true as const,value:{outcome,replayed:false}}})}catch(e){return fail(mapError(e))}
  }
  async commitImport(c: ImportCommit, incoming?:{authorDevice:string;bytes:Uint8Array}): Promise<CommitResult> {
    const k = storageOperationKey(c,'import'); if (!k.ok) return fail(k.error); if(c.commands.some(x=>['shopping-item-create','shopping-item-field','shopping-list-field'].includes(x.kind)))return fail('MALFORMED'); c = snapshot(c); incoming = snapshot(incoming);
    try { return await this.run(true,async tx => {
      const inbox = await tx.get(key('inbox',c.scopeId,c.itemId));
      if (incoming && (!inbox || !sameBytes(inbox.bytes,incoming.bytes))) conflict();
      const op = key('import',c.scopeId,c.operationId), old = await tx.get(op);
      if (old !== undefined) { if (old.inputKey !== k.value || !old.outcome) conflict(); await this.completedImport(tx,c,k.value); validateOutcome(old.outcome,c.documents); return {ok:true,value:{outcome:old.outcome,replayed:true}}; }
      await this.requireAuthority(tx,c.expectedAuthority);
      if (incoming) await this.requireIncomingAuthor(tx,c.scopeId,incoming.authorDevice);
      if (inbox === undefined || await tx.get(key('applied',c.scopeId,c.itemId)) !== undefined) conflict();
      for (const command of c.commands) {
        if (await tx.get(key('command',c.scopeId,command.commandId)) !== undefined || await tx.get(key('effect',c.scopeId,command.effectId)) !== undefined) conflict();
        await this.requireUnusedProjectionIdentity(tx,c.scopeId,command);
      }
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
      if (old !== undefined) { if (old !== representation) conflict(); const state=await tx.get(key('receipt-state',r.scopeId,r.objectId,r.destination,r.recipientId));if((r.state==='applied'&&state!=='applied')||(r.state==='stored'&&state!=='stored'&&state!=='applied'))corrupt();return {ok:true,value:{replayed:true}}; }
      if (await tx.get(key('object',r.scopeId,r.objectId)) === undefined) conflict();
      const stateKey = key('receipt-state',r.scopeId,r.objectId,r.destination,r.recipientId), state = await tx.get(stateKey);
      if (r.state === 'applied' && state !== 'stored' && state !== 'applied') conflict();
      if (r.state === 'stored' && state === 'applied') conflict();
      await tx.put(rk,representation); await tx.put(stateKey,r.state); this.fault?.('receipt');
      return {ok:true,value:{replayed:false}};
    }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
}
