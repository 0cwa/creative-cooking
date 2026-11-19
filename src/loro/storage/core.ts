import {hasSelectedRecipeChildren} from './selected-recipe-children.ts';
import {readLocalQuarantine, REVIEW_LIMITS} from '../compromise/review.mjs';
import {readContinuityHead} from './continuity-head.ts';
import type {LocalKeyRecord,ReadyMasterCatalog} from './local-keys.ts';
import {findLocalKey,installLocalKey,validLocalRecord,validMasterCatalog} from './local-keys.ts';
import { pairingReleaseKey, validatePairingAuthority, validPairingScope } from '../contracts/pairing.ts';
import type { ProjectionPublication, ProjectionAtomicStorage, ProjectionDocumentSet } from '../contracts/projection.ts';
import {MAX_SELECTED_CHILDREN, MAX_SELECTED_SET_BYTES, MAX_SELECTED_SOURCE_BYTES} from '../contracts/runtime-storage.ts';
import type { RecipeCatalogBinding, RecipePublication, RuntimeStorageReader, SelectedHouseholdSources, SelectedRecipeSource, ShoppingRecipeSourceReceipt } from '../contracts/runtime-storage.ts';
import type { PairingAtomicStorage, PairingAuthorityRecord, PairingAuthorityWrite, PairingRelease, PairingReleaseResult, PairingScope } from '../contracts/pairing.ts';
import { storageOperationKey, storageGroupKey, validateInboxItem, validateStorageReceipt } from '../contracts/index.ts';
import {isPolicyDocumentId} from '../authority/validator.mjs';
import {commandRecipeId,isRecipeDocumentId} from '../domain/recipe-document.mjs';
import type { AtomicStorage, CommitResult, GroupCommitResult, LocalCommit, LocalCommitGroup, ImportCommit, InboxItem, OutboxReceipt, StorageError, SavedOutcome, Result } from '../contracts/index.ts';

type Tx = { get(key: string): Promise<any>; put(key: string, value: any): Promise<void>; keys(): Promise<string[]> };
type RotationSourceGuard = {
  source:{documentId:string;bytes:Uint8Array;revision:number}|null;
} & ({} | {reviewId:string;review:unknown;original:{checkpoint:Uint8Array;objects:Uint8Array[]}});
export type PersonalSelection = {scopeId:string;pin:string};
type PersonalRotationReceipt = {
  requestHash:string;
  transfer:null|{parent:string;item:unknown;senderWrappingKey:string;sealedSnapshot:string;packages:Record<string,string>};
};
type PersonalRotationWrite = {
  deviceId:string;
  operationId:string;
  selection:{expected:PersonalSelection|null;next:PersonalSelection|null};
  expected:PairingAuthorityRecord|null;
  next:PairingAuthorityRecord;
  source?:{documentId:string;revision:number|null;bytes:Uint8Array|null};
  document:{id:string;bytes:Uint8Array};
  epochId:string;
  localKey:{record:LocalKeyRecord;catalog:ReadyMasterCatalog};
  identities:{commandId:string;effectId:string}[];
  receipt:PersonalRotationReceipt;
};
type AuthorityExpectation = LocalCommit['expectedAuthority'];
type HouseholdReadmissionRequest = {
  claim: {householdId:string;checkpoint:string;deviceId:string;nonce:string};
  sponsor: {deviceId:string;snapshot:string;signature:string};
  continuitySignature:string;
  deviceSignature:string;
  sponsorSignature:string;
};
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
export type PolicyDocumentSetMapping = {recipeId:string|null;sourceDocumentId:string;targetDocumentId:string;baseline:Uint8Array};
export type StagedPolicyDocumentSet = {version:1;sourceHead:string;targetHead:string;proof:Uint8Array;mapping:PolicyDocumentSetMapping[]};
export type StagePolicyDocumentSetInput = {guard:SelectedHouseholdSources;targetHead:string;proof:Uint8Array;mapping:PolicyDocumentSetMapping[]};
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
const hexOf = (value: unknown,length: number) => typeof value==='string' && value.length===length && /^[0-9a-f]+$/.test(value);
function validReadmissionRequest(v:unknown,scope:string,deviceId:string) {
  if(!object(v)||!object(v.claim)||v.claim.householdId!==scope||v.claim.deviceId!==deviceId||
    !validId(v.claim.checkpoint)||!hexOf(v.claim.nonce,64)||!hexOf(v.continuitySignature,128)||!hexOf(v.deviceSignature,128))return false;
  if(!Object.hasOwn(v,'sponsor'))return fields(v,['claim','continuitySignature','deviceSignature']);
  return fields(v,['claim','continuitySignature','deviceSignature','sponsor','sponsorSignature'])&&
    fields(v.sponsor,['deviceId','snapshot','signature'])&&validId(v.sponsor.deviceId)&&
    hexOf(v.sponsor.snapshot,64)&&hexOf(v.sponsor.signature,128)&&hexOf(v.sponsorSignature,128);
}
export const denseArray = (v: unknown, check: (item: any) => boolean): v is any[] => {
  if (!Array.isArray(v)) return false;
  for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v,i) || !check(v[i])) return false;
  return true;
};
const decodeKeyBytes = (x: unknown): Uint8Array => { if (!denseArray(x,n=>Number.isInteger(n) && n>=0 && n<=255)) return corrupt(); return new Uint8Array(x); };
const revision = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const outcomeShape = (v: unknown): v is SavedOutcome => fields(v,['state','revisions']) && v.state === 'saved' && denseArray(v.revisions, (x: unknown) => fields(x,['documentId','revision']) && typeof x.documentId === 'string' && x.documentId.length > 0 && revision(x.revision)) && v.revisions.length > 0;
export const validPersonalSelection = (value:unknown): value is PersonalSelection =>
  fields(value,['scopeId','pin']) && validId(value.scopeId) && hexOf(value.pin,64);
const sameRecord = (a:unknown,b:unknown) => JSON.stringify(projectionCanonical(a))===JSON.stringify(projectionCanonical(b));
type OwnDevicePublication = {
  operationId:string; guardId:string; expected:PairingAuthorityRecord; next:PairingAuthorityRecord;
  source:{documentId:string;revision:number|null;bytes:Uint8Array|null};
  document:{documentId:string;bytes:Uint8Array};
  file:Uint8Array|null; sources:{effectId:string;policyHashes:string[]}[];
};
type EstablishedRecipientReceipt = {recipientDeviceId:string;ceremonyGuardId:string;transcriptHash:string;ciphertextHash:string;ciphertext:Uint8Array};
type OwnDeviceSetSponsor = {deviceId:string;set:unknown;keyHashes:string[];signature:string;
  establishedRecipients?:{version:1;entries:EstablishedRecipientReceipt[]}};
// Established receipts reserve a distinct format; callers must verify a signature
// binding the ciphertext, local ceremony, and exact parent before using it.
type OwnDeviceSetPublication = {
  operationId:string; guardId:string; expected:PairingAuthorityRecord; next:PairingAuthorityRecord;
  copyHash:string; file:Uint8Array;
  documents:{recipeId:string|null; sourceDocumentId:string; documentId:string; bytes:Uint8Array;
    identities:{commandId:string;effectId:string}[];
    sources:{effectId:string;policyHashes:string[]}[]; policies?:any[]; localKey:{record:LocalKeyRecord;catalog:ReadyMasterCatalog}}[];
} & ({guard:SelectedHouseholdSources;recipient?:never;sponsor?:OwnDeviceSetSponsor} |
     {guard?:never;sponsor?:never;recipient:{deviceId:string;fileHash:string;signature:string}} |
     {guard:SelectedHouseholdSources;sponsor?:never;recipient:{deviceId:string;fileHash:string;signature:string;kind:'established';transcriptHash:string;evidence?:any}});
type PersonalPairingPublication = {
  expected:PairingAuthorityRecord;
  source:{documentId:string;revision:number|null;bytes:Uint8Array|null};
  file:Uint8Array;
  selection:{deviceId:string;expected:PersonalSelection|null};
};
const validPairingFile = (value:unknown): value is Uint8Array =>
  value instanceof Uint8Array && value.length>112 && value.length<=7*1024*1024;
// Bound both the number of recipients and their combined retained ciphertext bytes.
const MAX_ESTABLISHED_RECIPIENTS = 127, MAX_ESTABLISHED_CIPHERTEXT_BYTES = 16*1024*1024;
const validEstablishedRecipients = (value:unknown) => {
  if(!fields(value,['version','entries'])||value.version!==1||!Array.isArray(value.entries)||
    value.entries.length<1||value.entries.length>MAX_ESTABLISHED_RECIPIENTS||
    !denseArray(value.entries,entry=>fields(entry,['recipientDeviceId','ceremonyGuardId','transcriptHash','ciphertextHash','ciphertext'])&&
      validId(entry.recipientDeviceId)&&validId(entry.ceremonyGuardId)&&hexOf(entry.transcriptHash,64)&&
      hexOf(entry.ciphertextHash,64)&&validPairingFile(entry.ciphertext)))return false;
  return value.entries.every((entry,i)=>i===0||value.entries[i-1].recipientDeviceId<entry.recipientDeviceId)&&
    value.entries.reduce((sum,entry)=>sum+entry.ciphertext.length,0)<=MAX_ESTABLISHED_CIPHERTEXT_BYTES;
};
const validOwnDeviceSetSponsor = (value:any, count:number) =>
  (fields(value,['deviceId','set','keyHashes','signature'])||fields(value,['deviceId','set','keyHashes','signature','establishedRecipients'])&&
    validEstablishedRecipients(value.establishedRecipients))&&validId(value.deviceId)&&object(value.set)&&
  denseArray(value.keyHashes,hash=>hexOf(hash,64))&&value.keyHashes.length===count&&hexOf(value.signature,128);
const validEstablishedEvidence = (value:unknown) => {
  try { return object(value) && JSON.stringify(value).length <= 262144; } catch { return false; }
};
const validPersonalReceipt = (value:unknown): value is PersonalRotationReceipt =>
  fields(value,['requestHash','transfer']) && hexOf(value.requestHash,64) &&
  (value.transfer===null || (fields(value.transfer,['parent','item','senderWrappingKey','sealedSnapshot','packages']) &&
    typeof value.transfer.parent==='string' && value.transfer.parent.length<=2_200_000 && object(value.transfer.item) &&
    hexOf(value.transfer.senderWrappingKey,64) && typeof value.transfer.sealedSnapshot==='string' &&
    value.transfer.sealedSnapshot.length<=4_200_000 && object(value.transfer.packages) &&
    Object.keys(value.transfer.packages).length<=127 &&
    Object.values(value.transfer.packages).every(v=>typeof v==='string' && v.length<=32768)));
const validStagedPolicyDocumentSet = (v:unknown): v is StagedPolicyDocumentSet => {
  if(!fields(v,['version','sourceHead','targetHead','proof','mapping']) || v.version!==1 ||
    !validId(v.sourceHead) || !validId(v.targetHead) || v.sourceHead===v.targetHead ||
    !(v.proof instanceof Uint8Array) || !v.proof.length || v.proof.length>MAX_SELECTED_SET_BYTES ||
    !denseArray(v.mapping,(row:any)=>fields(row,['recipeId','sourceDocumentId','targetDocumentId','baseline']) &&
      (row.recipeId===null || validId(row.recipeId)) && validId(row.sourceDocumentId) && validId(row.targetDocumentId) &&
      row.baseline instanceof Uint8Array && row.baseline.length>0 && row.baseline.length<=MAX_SELECTED_SOURCE_BYTES) ||
    !v.mapping.length || v.mapping.length>MAX_SELECTED_CHILDREN+1 || v.mapping[0].recipeId!==null ||
    v.mapping.slice(1).some((row:any,i:number)=>row.recipeId===null || (i>0 && v.mapping[i].recipeId>=row.recipeId))) return false;
  const sources=new Set(v.mapping.map((row:any)=>row.sourceDocumentId));
  const targets=new Set(v.mapping.map((row:any)=>row.targetDocumentId));
  return sources.size===v.mapping.length && targets.size===v.mapping.length &&
    v.mapping.every((row:any)=>!sources.has(row.targetDocumentId) &&
      (!isPolicyDocumentId(row.targetDocumentId) || row.targetDocumentId===`policy-${v.targetHead}`)) &&
    v.mapping.reduce((sum:number,row:any)=>sum+row.baseline.length,v.proof.length)<=MAX_SELECTED_SET_BYTES;
};
const validateRecord = (k: string, v: any) => {
  if (v === undefined) return;
  const parts=JSON.parse(k),namespace=parts[0];
  let valid = false;
  switch (namespace) {
    case 'compromise-review': valid=object(v) && v.version===1 && typeof v.reviewId==='string'; break;
    case 'compromise-frozen-original': valid=fields(v,['checkpoint','objects']) && v.checkpoint instanceof Uint8Array && denseArray(v.objects,entry=>entry instanceof Uint8Array); break;
    case 'compromise-quarantine': valid=typeof v==='boolean'; break;
    case 'disclosure-pending': valid=fields(v,['reason','objectId']) && v.reason==='POLICY_GOVERNANCE_UNPROVEN' && typeof v.objectId==='string' && !!v.objectId; break;
    case 'disclosure-active': case 'policy-disclosure-head': valid=v===null || typeof v==='string' && !!v; break;
    case 'policy-staged-set': valid=validStagedPolicyDocumentSet(v) && parts.length===3 && v.targetHead===parts[2]; break;
    case 'household-own-device-parent': case 'policy-checkout-parent': valid=validBranchDocument(v); break;
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
    case 'recovery-install': {
      const [,category,scope,deviceId]=parts;
      valid=parts.length===4&&category==='readmission-request'&&validId(scope)&&validId(deviceId)&&validReadmissionRequest(v,scope,deviceId);
      break;
    }
    case 'recovery-challenge-consumed': valid=typeof v==='string' && !!v; break;
    case 'local-master-catalog': valid = validMasterCatalog(v) || (fields(v,['version','state','id']) && v.version===1 && v.state==='reserved' && typeof v.id==='string' && !!v.id); break;
    case 'local-key': case 'local-key-operation': valid = validLocalRecord(v); break;
    case 'projection-publication': valid = fields(v,['inputKey','input']) && typeof v.inputKey==='string' && projectionKey(v.input)===v.inputKey; break;
    case 'projection-manifest': case 'projection-package': valid = v instanceof Uint8Array; break;
    case 'projection-outbox': valid = fields(v,['packageId','recipientDevice']) && typeof v.packageId==='string' && typeof v.recipientDevice==='string'; break;
    case 'projection-pending': valid = typeof v==='string'; break;
    case 'projection-document': valid = fields(v,['generation','operationId']) && revision(v.generation) && typeof v.operationId==='string'; break;
    case 'household-own-device-sources': valid=denseArray(v,row=>fields(row,['effectId','policyHashes'])&&validId(row.effectId)&&denseArray(row.policyHashes,validId)); break;
    case 'household-own-device-set': {
      const base=['version','next','guardId','copyHash','file','mapping'];
      valid=(fields(v,base)||fields(v,[...base,'expected','recipient'])&&validatePairingAuthority(v.expected).ok&&
        (fields(v.recipient,['deviceId','fileHash','signature'])||(fields(v.recipient,['deviceId','fileHash','signature','kind','transcriptHash'])||fields(v.recipient,['deviceId','fileHash','signature','kind','transcriptHash','evidence'])&&validEstablishedEvidence(v.recipient.evidence))&&v.recipient.kind==='established'&&hexOf(v.recipient.transcriptHash,64))&&validId(v.recipient.deviceId)&&
        hexOf(v.recipient.fileHash,64)&&hexOf(v.recipient.signature,128)||
        fields(v,[...base,'expected','sponsor'])&&validatePairingAuthority(v.expected).ok&&
        validOwnDeviceSetSponsor(v.sponsor,v.mapping?.length))&&
        v.version===1&&validatePairingAuthority(v.next).ok&&validId(v.guardId)&&hexOf(v.copyHash,64)&&validPairingFile(v.file)&&
        denseArray(v.mapping,row=>fields(row,['recipeId','sourceDocumentId','documentId'])&&(row.recipeId===null||validId(row.recipeId))&&validId(row.sourceDocumentId)&&validId(row.documentId));
      break;
    }
    case 'household-own-device': valid=fields(v,['next','guardId','documentId','file'])&&validatePairingAuthority(v.next).ok&&validId(v.guardId)&&validId(v.documentId)&&(v.file===null||validPairingFile(v.file)); break;
    case 'personal-pairing-file': valid = validPairingFile(v); break;
    case 'personal-selection': valid = validPersonalSelection(v); break;
    case 'personal-rotation': valid = fields(v,['receipt','epochId','documentId','head']) && validPersonalReceipt(v.receipt) && [v.epochId,v.documentId,v.head].every(validId); break;
    case 'pairing-authority': valid = validatePairingAuthority(v).ok; break;
    case 'pairing-release': { const parsed = fields(v,['inputKey','release']) ? pairingReleaseKey(v.release) : null; valid = !!parsed && parsed.ok && parsed.value === v.inputKey; break; }
    case 'pairing-guard': case 'pairing-packet': case 'pairing-outbox': case 'personal-admission-release': valid = typeof v === 'string' && v.length > 0; break;
    case 'document-owner': valid = typeof v==='string' && !!v; break;
    case 'document': valid = fields(v,['bytes','revision']) && v.bytes instanceof Uint8Array && revision(v.revision); break;
    case 'projection-document-set': valid=fields(v,['manifestId','operationId','catalog']) &&
      validId(v.manifestId) && validId(v.operationId) && denseArray(v.catalog,entry=>fields(entry,['recipeId','documentId']) &&
        validId(entry.recipeId) && isRecipeDocumentId(entry.documentId)); break;
    case 'recipe-catalog': valid = fields(v,['binding','recipeId','sourceRevision','documentId','effectId','objectId']) &&
      validRecipeCatalogBinding(v.binding) && [v.recipeId,v.documentId,v.effectId,v.objectId].every(validId) &&
      (v.sourceRevision===null || revision(v.sourceRevision)); break;
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
function validRecipeCatalogBinding(binding:unknown):binding is RecipeCatalogBinding {
  return fields(binding,['version','rootPin','scopeId','branchHead','sourceDocumentId','documentGeneration','epochId']) &&
    binding.version===1 && [binding.rootPin,binding.scopeId,binding.branchHead,binding.sourceDocumentId,binding.epochId].every(validId) &&
    revision(binding.documentGeneration) && binding.documentGeneration>0;
}
const validBranchDocument = (x: unknown): x is BranchDocument => fields(x,['head','documentId']) && validId(x.head) && validId(x.documentId);
const validBranchRevision = (x: unknown): x is BranchRevision => fields(x,['head','documentId','revision']) && validId(x.head) && validId(x.documentId) && (x.revision===null || revision(x.revision));
const projectionCanonical = (v: unknown): unknown => v instanceof Uint8Array ? Array.from(v) : Array.isArray(v) ? v.map(projectionCanonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,projectionCanonical(v[k])])) : v;
function projectionSetValid(x:Record<string,any>,set:unknown):set is ProjectionDocumentSet {
 const base=['version','mode','recipientSignature','catalog','seeds','childKeys'];
 if (!(fields(set,base) && set.version===1 ||
       fields(set,[...base,'ciphertextHash']) && set.version===1 && set.mode==='recipient' &&
       typeof set.ciphertextHash==='string' && /^[0-9a-f]{64}$/.test(set.ciphertextHash) ||
       fields(set,[...base,'publisherParent','publisherSelection','ciphertextHash']) &&
       set.version===2 && set.mode==='recipient' && object(set.publisherParent) && object(set.publisherSelection) &&
       typeof set.ciphertextHash==='string' && /^[0-9a-f]{64}$/.test(set.ciphertextHash)) ||
     !['publisher','recipient'].includes(set.mode) || !Array.isArray(x.documents) || !Array.isArray(x.guardIds) ||
     (set.mode==='recipient'
       ? x.guardIds.length!==1 || x.pendingEdits?.length!==0 ||
         !(set.recipientSignature instanceof Uint8Array) || set.recipientSignature.length!==64
       : set.recipientSignature!==null) ||
     !denseArray(set.catalog,entry=>fields(entry,['recipeId','documentId']) && validId(entry.recipeId) &&
       isRecipeDocumentId(entry.documentId)) || set.catalog.length!==x.documents.length-1 ||
     !denseArray(set.seeds,entry=>fields(entry,['documentId','seed','policySeed']) && validId(entry.documentId) &&
       fields(entry.seed,['seedId','identities']) && validId(entry.seed.seedId) &&
       denseArray(entry.seed.identities,identity=>fields(identity,['effectId','commandId']) && validId(identity.effectId) &&
         validId(identity.commandId)) && entry.seed.identities.length<=256 &&
       (entry.policySeed===null || fields(entry.policySeed,['bundle','bundleHash']) && object(entry.policySeed.bundle) &&
         validId(entry.policySeed.bundleHash) && denseArray(entry.policySeed.bundle.policies,
           record=>fields(record,['policy','policyHash','approvals']) && validId(record.policyHash) &&
             object(record.policy) && Array.isArray(record.approvals)) &&
         entry.policySeed.bundle.policies.length<=64)) || set.seeds.length!==x.documents.length ||
     !denseArray(set.childKeys,validLocalRecord) || set.childKeys.length!==set.catalog.length ||
     !fields(x.manifest,['id','bytes']) || !(x.manifest.bytes instanceof Uint8Array) || x.manifest.bytes.length>64*1024) return false;
 let manifest;
 try {manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(x.manifest.bytes))} catch {return false;}
 if (manifest?.version!==5 || manifest.admissionEventHash!==x.admissionEventHash ||
     manifest.newEpochId!==x.epochId || manifest.parentHead!==x.expectedAuthority?.record?.acceptedParent ||
     manifest.authorizationSnapshot!==(set.version===2?set.publisherParent?.authorizationSnapshot:x.expectedAuthority?.record?.authorizationSnapshot) ||
     (set.version===2 && (set.publisherParent?.acceptedParent!==x.expectedAuthority?.record?.acceptedParent ||
       !sameRecord(set.publisherParent?.scope,x.expectedAuthority?.scope))) ||
     x.nextAuthority?.acceptedParent!==x.admissionEventHash || manifest.catalog?.targetRevision!==set.catalog.length ||
     !Array.isArray(manifest.entries) || manifest.entries.length!==set.seeds.length) return false;
 const epochSlots=new Set([x.epochId]), ops=new Set([x.localKey?.record?.operationId]);
 const seeds=new Set(), effects=new Set(), commands=new Set();
 for (const [index,entry] of set.seeds.entries()) {
   const doc=x.documents[index],declared=manifest.entries[index];
   if (!doc || doc.documentId!==entry.documentId || doc.generation!==manifest.newGeneration ||
       declared?.documentId!==entry.documentId || declared.seedId!==entry.seed.seedId ||
       declared.policyBundleHash!==(entry.policySeed?.bundleHash??null) || seeds.has(entry.seed.seedId)) return false;
   seeds.add(entry.seed.seedId);
   for (const identity of entry.seed.identities) {
     if (effects.has(identity.effectId)||commands.has(identity.commandId)) return false;
     effects.add(identity.effectId);commands.add(identity.commandId);
   }
   if (index===0) {
     if (declared.recipeId!==null || doc.documentId!==manifest.newDocumentId) return false;
     continue;
   }
   const row=set.catalog[index-1], local=set.childKeys[index-1];
   const root=x.localKey?.record, identity=local.identity;
   if (row.documentId!==doc.documentId || row.recipeId!==declared.recipeId ||
       (index>1 && set.catalog[index-2].recipeId>=row.recipeId) || !root ||
       local.masterId!==root.masterId || !sameRecord(identity.scope,root.identity.scope) ||
       identity.deviceId!==root.identity.deviceId || identity.purpose!=='data' ||
       epochSlots.has(identity.epochId) || ops.has(local.operationId)) return false;
   epochSlots.add(identity.epochId);ops.add(local.operationId);
 }
 return true;
}
function projectionKey(x: unknown,allowUnboundV2=false,allowSet=false): string | null {
 if(object(x)&&Object.hasOwn(x,'documentSet')){
   const {documentSet,...rest}=x;
   if (!projectionSetValid(rest,documentSet) || ['seed','policySeed','singleRecipient','recovery','sourceDocument'].some(name=>Object.hasOwn(rest,name))) return null;
   const {guardIds}=rest;
   if (!denseArray(guardIds,validId) || !guardIds.length || guardIds.length>128 ||
       guardIds.some((value:string,index:number)=>index>0&&guardIds[index-1]>=value) ||
       projectionKey(rest,false,true)===null) return null;
   const encoded=JSON.stringify(projectionCanonical(x));
   return new TextEncoder().encode(encoded).length<=16*1024*1024?encoded:null;
 }
 if(!allowSet&&object(x)&&object(x.manifest)&&x.manifest.bytes instanceof Uint8Array){
   try{if(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(x.manifest.bytes))?.version===5)return null}catch{}
 }
 if(object(x)&&Object.hasOwn(x,'policySeed')){const {policySeed,...rest}=x;if(!fields(policySeed,['bundle','bundleHash'])||!object(policySeed.bundle)||!validId(policySeed.bundleHash)||!rest.seed||!rest.sourceDocument||!rest.manifest||!(rest.manifest.bytes instanceof Uint8Array))return null;let m:any;try{m=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rest.manifest.bytes))}catch{return null}const b:any=policySeed.bundle;if(!fields(b,['version','scopeId','sourceHead','sourceDocumentId','sourceRevision','seedId','peerId','snapshotHash','entries','policies'])||![2,3,4].includes(b.version)||m.version!==b.version||m.policyBundleHash!==policySeed.bundleHash||m.sourceRevision!==b.sourceRevision||m.sourceDocument!==b.sourceDocumentId||b.sourceDocumentId!==rest.sourceDocument.documentId||b.sourceRevision!==rest.sourceDocument.revision||b.sourceHead!==rest.expectedAuthority?.record?.acceptedParent||b.scopeId!==rest.expectedAuthority?.scope?.id||b.seedId!==rest.seed.seedId||m.schemaVersion!==`registry-seed-v${b.version}|${b.seedId}|${b.peerId}`||!validId(b.snapshotHash)||!denseArray(b.entries,(e:any)=>(b.version===2?fields(e,['effectId','policyHashes']):fields(e,['effectId','policyHashes','incomplete'])&&typeof e.incomplete==='boolean')&&validId(e.effectId)&&denseArray(e.policyHashes,validId)&&(e.policyHashes.length>0||b.version>=3&&e.incomplete===true)&&e.policyHashes.length<=64&&e.policyHashes.every((h:string,i:number)=>!i||e.policyHashes[i-1]<h))||b.entries.length>256||!denseArray(b.policies,(p:any)=>fields(p,['policy','policyHash','approvals'])&&object(p.policy)&&validId(p.policyHash)&&Array.isArray(p.approvals))||b.policies.length>64||!Array.isArray(rest.seed.identities)||JSON.stringify(b.entries.map((e:any)=>e.effectId))!==JSON.stringify(rest.seed.identities.map((e:any)=>e.effectId).sort())||projectionKey(rest,true)===null)return null;const encoded=JSON.stringify(projectionCanonical(x));return new TextEncoder().encode(encoded).length<=2500000?encoded:null;}
 if(object(x)&&Object.hasOwn(x,'seed')){const {seed,...rest}=x;if(!fields(seed,['seedId','identities'])||!validId(seed.seedId)||!denseArray(seed.identities,(i:any)=>fields(i,['commandId','effectId'])&&validId(i.commandId)&&validId(i.effectId))||seed.identities.length>256||new Set(seed.identities.map((i:any)=>i.commandId)).size!==seed.identities.length||new Set(seed.identities.map((i:any)=>i.effectId)).size!==seed.identities.length||projectionKey(rest,allowUnboundV2)===null)return null;return JSON.stringify(projectionCanonical(x));}
 if(object(x)&&Object.hasOwn(x,'singleRecipient')){const {singleRecipient,...rest}=x;if(singleRecipient!==true||!Array.isArray(rest.packages)||rest.packages.length!==0||Object.hasOwn(rest,'guardId')||Object.hasOwn(rest,'guardIds')||Object.hasOwn(rest,'recovery')||projectionKey({...rest,guardIds:['local-only-placeholder'],packages:[{id:'local-only-placeholder',recipientDevice:'local-only-placeholder',bytes:new Uint8Array([0])}]},allowUnboundV2)===null)return null;return JSON.stringify(projectionCanonical(x));}
 if(object(x)&&Object.hasOwn(x,'recovery')){const r=x.recovery,{recovery,...rest}=x;if(!fields(r,['owner','generation','bindingHash','claimHash','tokenCommitment','sealed'])||!validId(r.owner)||!revision(r.generation)||![r.bindingHash,r.claimHash,r.tokenCommitment].every(validId)||typeof r.sealed!=='string'||r.sealed.length>16384||!/^[0-9a-f]+$/.test(r.sealed)||projectionKey(rest,allowUnboundV2)===null)return null;return JSON.stringify(projectionCanonical(x));}
 if(!allowUnboundV2&&object(x)&&object(x.manifest)&&x.manifest.bytes instanceof Uint8Array){try{if([2,3,4].includes(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(x.manifest.bytes))?.version))return null}catch{}}
 const setFields=['version','operationId','guardIds','expectedAuthority','nextAuthority','admissionEventHash',
   'grantHash','manifest','epochId','documents','packages','localKey','pendingEdits'];
 if (!(allowSet&&fields(x,setFields) || fields(x,['version','operationId','expectedAuthority','nextAuthority','admissionEventHash','grantHash','manifest','epochId','documents','packages','localKey','pendingEdits']) || (fields(x,['version','operationId','guardId','expectedAuthority','nextAuthority','admissionEventHash','grantHash','manifest','epochId','documents','packages','localKey','pendingEdits']) && validId(x.guardId)) || (fields(x,['version','operationId','guardId','sourceDocument','expectedAuthority','nextAuthority','admissionEventHash','grantHash','manifest','epochId','documents','packages','localKey','pendingEdits']) && validId(x.guardId) && fields(x.sourceDocument,['documentId','revision']) && validId(x.sourceDocument.documentId) && revision(x.sourceDocument.revision)) || (fields(x,['version','operationId','guardIds','sourceDocument','expectedAuthority','nextAuthority','admissionEventHash','grantHash','manifest','epochId','documents','packages','localKey','pendingEdits']) && denseArray(x.guardIds,validId) && x.guardIds.length>0 && x.guardIds.length<=128 && x.guardIds.every((v:string,i:number)=>!i || x.guardIds[i-1]<v) && fields(x.sourceDocument,['documentId','revision']) && validId(x.sourceDocument.documentId) && (x.sourceDocument.revision===null || revision(x.sourceDocument.revision)))) || x.version!==1 || ![x.operationId,x.admissionEventHash,x.grantHash,x.epochId].every(validId)) return null;
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
    try { return await this.run(true,async tx => { const r=write.record, k=key('pairing-authority',r.scope.kind,r.scope.id), old=await tx.get(k); if (old && (old.scope.kind !== r.scope.kind || old.scope.id !== r.scope.id)) corrupt(); if ((old === undefined ? null : old.revision) !== write.expectedRevision) conflict();
      if (r.scope.kind==='household' && old && old.acceptedParent!==r.acceptedParent) {
        await this.requireSingleHouseholdDocument(tx,r.scope.id,[old.acceptedParent,r.acceptedParent]);
      }
      if (r.scope.kind==='household'&&old&&await tx.get(key('projection-document-set',r.scope.id,old.acceptedParent))!==undefined) {
        // An installed set permits only one appended agreement at its current
        // head. Authority replay verifies its signatures before use.
        let before:any,after:any;
        try {
          const decoder=new TextDecoder('utf-8',{fatal:true});
          before=JSON.parse(decoder.decode(old.authorityState));
          after=JSON.parse(decoder.decode(r.authorityState));
        } catch { throw new StorageFailure('UNSUPPORTED_VERSION'); }
        const prior=before?.agreements??[],next=after?.agreements;
        if (r.acceptedParent!==old.acceptedParent || !Array.isArray(prior) || !Array.isArray(next) ||
            next.length!==prior.length+1 || next.at(-1)?.parentHead!==old.acceptedParent ||
            !sameRecord(next.slice(0,-1),prior) ||
            !sameRecord({...after,agreements:prior},{...before,agreements:prior})) {
          throw new StorageFailure('UNSUPPORTED_VERSION');
        }
      }
      await tx.put(k,r); this.fault?.('pairing-authority'); return {ok:true,value:undefined}; }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  /** Retain an independently verified public proof without granting local authority. */
  async retainPublicHouseholdParent(record:PairingAuthorityRecord):Promise<Result<{replayed:boolean},StorageError>> {
    const checked=validatePairingAuthority(record);
    if(!checked.ok)return checked;
    if(record.scope.kind!=='household'||record.revision!==0)return {ok:false,error:'MALFORMED'};
    record=snapshot(record);
    try{return await this.run(true,async tx=>({ok:true,value:{replayed:await this.retainPublicParent(tx,record,false)}}));}
    catch(error){return {ok:false,error:mapError(error)};}
  }
  private async retainPublicParent(tx:Tx,record:PairingAuthorityRecord,replace:boolean):Promise<boolean> {
    const scope=record.scope.id,slot=key('pairing-authority','household',scope),prior=await tx.get(slot);
    if(prior===undefined){
      if(replace)return conflict();
    }else{
      if(!validatePairingAuthority(prior).ok||prior.scope.kind!=='household'||prior.scope.id!==scope)return corrupt();
      if(prior.revision!==0||prior.acceptedParent!==record.acceptedParent)return conflict();
      if(prior.authorizationSnapshot===record.authorizationSnapshot&&sameBytes(prior.authorityState,record.authorityState))return true;
      if(!replace)return conflict();
      const localPrefixes=[key('local-key','household',scope),...['document','document-owner','projection-document','projection-publication',
        'recipient-admission','recipient-admission-event','continuity-head','continuity-binding','inbox','object'].map(kind=>key(kind,scope))]
        .map(prefix=>prefix.slice(0,-1)+',');
      if((await tx.keys()).some(k=>localPrefixes.some(prefix=>k.startsWith(prefix))))return conflict();
    }
    await tx.put(slot,record);
    return false;
  }
  /** Store an already signed request and its verified sponsor parent together. */
  async commitHouseholdReadmissionRequest(record:PairingAuthorityRecord,request:HouseholdReadmissionRequest):Promise<Result<HouseholdReadmissionRequest,StorageError>> {
    const checked=validatePairingAuthority(record);
    if(!checked.ok)return checked;
    if(record.scope.kind!=='household'||record.revision!==0||!validId(request?.claim?.deviceId)||
      !validReadmissionRequest(request,record.scope.id,request.claim.deviceId)||request.claim.checkpoint!==record.acceptedParent||
      request.sponsor?.snapshot!==record.authorizationSnapshot)return {ok:false,error:'MALFORMED'};
    record=snapshot(record);
    request=snapshot(request);
    try{return await this.run(true,async tx=>{
      const sameParent=await this.retainPublicParent(tx,record,true);
      if(!sameParent)this.fault?.('readmission-parent');
      const slot=key('recovery-install','readmission-request',record.scope.id,request.claim.deviceId),prior=await tx.get(slot);
      const same=(a:unknown,b:unknown)=>JSON.stringify(projectionCanonical(a))===JSON.stringify(projectionCanonical(b));
      if(sameParent&&prior&&same({...prior.claim,nonce:request.claim.nonce},request.claim)&&same(prior.sponsor,request.sponsor)){
        return {ok:true as const,value:snapshot(prior)};
      }
      await tx.put(slot,request);
      this.fault?.('readmission-request');
      return {ok:true as const,value:snapshot(request)};
    });}catch(error){return {ok:false,error:mapError(error)};}
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
  private async requireSingleHouseholdDocument(tx:Tx,scope:string,heads:string[]) {
    if (await hasSelectedRecipeChildren(tx,scope,heads)) throw new StorageFailure('UNSUPPORTED_VERSION');
  }
  /** These read-only observations are for the verified checkout path only. */
  async readPolicyCheckoutDocuments(expected:AuthorityExpectation,from:BranchDocument,target:BranchDocument,parent:BranchDocument|null) {
    if(expected?.scope?.kind!=='household'||!validBranchDocument(from)||!validBranchDocument(target)||
      expected.record?.acceptedParent!==from.head||from.head===target.head||from.documentId===target.documentId||
      (parent!==null&&!validBranchDocument(parent))) return fail('MALFORMED');
    try{return await this.run(false,async tx=>{
      await this.requireAuthority(tx,expected);
      const scope=expected.scope.id;
      await this.requireSingleHouseholdDocument(tx,scope,[from.head,target.head,...(parent?[parent.head]:[])]);
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
      await this.requireSingleHouseholdDocument(tx,scope,[from.head,target.head,...(parent?[parent.head]:[])]);
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
  /** Stage caller-verified evidence and baselines without changing the selected authority. */
  async stagePolicyDocumentSet(input:StagePolicyDocumentSetInput):Promise<{ok:true;value:void}|ReturnType<typeof fail>> {
    input=snapshot(input);
    const {guard,targetHead,proof,mapping}=input;
    if(!guard?.expectedAuthority?.scope || !this.matchesRecipeCatalog(guard.binding,guard.expectedAuthority) ||
      !denseArray(guard.entries,entry=>object(entry)&&validId(entry.recipeId)&&validId(entry.documentId)) ||
      guard.entries.length+(guard.members?.length??0)>MAX_SELECTED_CHILDREN || guard.catalogRevision!==guard.entries.length ||
      guard.members!==undefined&&!denseArray(guard.members,member=>object(member)&&validId(member.recipeId)&&validId(member.documentId)&&revision(member.revision)&&member.bytes instanceof Uint8Array)) return fail('MALFORMED');
    const record:StagedPolicyDocumentSet={version:1,sourceHead:guard.binding.branchHead,targetHead,proof,mapping};
    if(!validStagedPolicyDocumentSet(record))return fail('MALFORMED');
    const expected=[{recipeId:null,documentId:guard.binding.sourceDocumentId},
      ...[...guard.entries,...(guard.members??[])].sort((a,b)=>a.recipeId<b.recipeId?-1:a.recipeId>b.recipeId?1:0)];
    if(expected.length!==mapping.length || expected.some((row,i)=>row.recipeId!==mapping[i].recipeId || row.documentId!==mapping[i].sourceDocumentId)) return fail('MALFORMED');
    try{return await this.run(true,async tx=>{
      await this.requireSelectedHouseholdSources(tx,guard);
      const scope=guard.binding.scopeId;
      if(await tx.get(key('policy-staged-set',scope,targetHead))!==undefined) conflict();
      for(const row of mapping) {
        if(await tx.get(key('document',scope,row.targetDocumentId))!==undefined ||
          await tx.get(key('document-owner',scope,row.targetDocumentId))!==undefined ||
          await tx.get(key('policy-checkout-parent',scope,row.targetDocumentId))!==undefined) conflict();
      }
      for(const row of mapping) {
        await tx.put(key('document-owner',scope,row.targetDocumentId),targetHead);
        await tx.put(key('document',scope,row.targetDocumentId),{bytes:copy(row.baseline),revision:0});
        await tx.put(key('policy-checkout-parent',scope,row.targetDocumentId),{head:record.sourceHead,documentId:row.sourceDocumentId});
        this.fault?.('policy-set-target');
      }
      await tx.put(key('policy-staged-set',scope,targetHead),record);
      return {ok:true as const,value:undefined};
    });}catch(e){return fail(mapError(e));}
  }
  /** Retained data is structural evidence only; callers must authenticate it before use. */
  async readStagedPolicyDocumentSet(scope:string,targetHead:string):Promise<{ok:true;value:StagedPolicyDocumentSet|null}|ReturnType<typeof fail>> {
    if(!validId(scope)||!validId(targetHead))return fail('MALFORMED');
    try{return await this.run(false,async tx=>{
      const record:StagedPolicyDocumentSet|undefined=await tx.get(key('policy-staged-set',scope,targetHead));
      if(!record)return {ok:true as const,value:null};
      for(const row of record.mapping){
        const owner=await tx.get(key('document-owner',scope,row.targetDocumentId));
        const doc=await tx.get(key('document',scope,row.targetDocumentId));
        const parent=await tx.get(key('policy-checkout-parent',scope,row.targetDocumentId));
        if(owner!==targetHead || !doc || doc.revision!==0 || !sameBytes(doc.bytes,row.baseline) ||
          !sameRecord(parent,{head:record.sourceHead,documentId:row.sourceDocumentId}))return corrupt();
      }
      return {ok:true as const,value:snapshot(record)};
    });}catch(e){return fail(mapError(e));}
  }
  private async checkProjection(tx:Tx,p:ProjectionPublication,inputKey:string) {
    const scope=p.expectedAuthority.scope.id;
    const authority=await tx.get(key('pairing-authority','household',scope));
    if(!authority || authority.scope.kind!=='household' || authority.scope.id!==scope || authority.revision<p.nextAuthority.revision || (authority.revision===p.nextAuthority.revision && JSON.stringify(projectionCanonical(authority))!==JSON.stringify(projectionCanonical(p.nextAuthority)))) return corrupt();
    if(p.documentSet){
      if(projectionKey(p)!==inputKey) return corrupt();
      const set=p.documentSet,head=p.nextAuthority.acceptedParent;
      const selectedIds=new Set(p.documents.map(entry=>entry.documentId));
      const selectedRecipes=new Set(set.catalog.map(entry=>entry.recipeId));
      const catalogPrefix=key('recipe-catalog',scope,head).slice(0,-1)+',';
      const ownerPrefix=key('document-owner',scope).slice(0,-1)+',';
      const slots=await tx.keys();
      for(const slot of slots.filter(slot=>slot.startsWith(catalogPrefix))){
        const row=await tx.get(slot);
        if(!row||!isRecipeDocumentId(row.documentId)||selectedIds.has(row.documentId)||selectedRecipes.has(row.recipeId)||
           row.binding.sourceDocumentId!==p.documents[0].documentId||
           row.binding.branchHead!==head||row.binding.scopeId!==scope||
           row.binding.epochId!==p.epochId||row.binding.documentGeneration!==p.documents[0].generation||
           slot!==key('recipe-catalog',scope,head,row.recipeId)||
           await tx.get(key('document-owner',scope,row.documentId))!==head)return corrupt();
        selectedIds.add(row.documentId);
        selectedRecipes.add(row.recipeId);
      }
      for(const slot of slots){
        if(!slot.startsWith(ownerPrefix)) continue;
        const documentId=JSON.parse(slot)[2];
        if(isRecipeDocumentId(documentId)&&!selectedIds.has(documentId)&&await tx.get(slot)===head) return corrupt();
      }
      if(!sameRecord(await tx.get(key('projection-document-set',scope,p.nextAuthority.acceptedParent)),
        {manifestId:p.manifest.id,operationId:p.operationId,catalog:set.catalog})) return corrupt();
      for(const entry of set.seeds){
        if(!sameRecord(await tx.get(key('projection-seed',scope,entry.documentId)),entry.seed) ||
           !sameRecord((await tx.get(key('projection-policy-seed',scope,entry.documentId)))??null,entry.policySeed)) return corrupt();
        for(const identity of entry.seed.identities){
          if(await tx.get(key('projection-seed-command',scope,entry.documentId,identity.commandId))!==entry.seed.seedId ||
             await tx.get(key('projection-seed-effect',scope,entry.documentId,identity.effectId))!==entry.seed.seedId) return corrupt();
        }
      }
      for(const entry of set.seeds){
        for(const policy of (entry.policySeed?.bundle as any)?.policies??[]){
          if(!sameRecord(await tx.get(key('disclosure-policy-archive',scope,policy.policyHash)),policy)) return corrupt();
        }
      }
      for(const record of set.childKeys){
        try{if(!sameRecord(await findLocalKey(tx,record.operationId,record.identity),record)) return corrupt();}
        catch{return corrupt();}
      }
    }
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
      if (!doc || await tx.get(key('document-owner',scope,d.documentId))!==p.nextAuthority.acceptedParent ||
        !meta || meta.generation!==d.generation || meta.operationId!==p.operationId ||
        (doc.revision===0 && !sameBytes(doc.bytes,d.bytes)) ||
        (p.documentSet && doc.revision>0 && sameBytes(doc.bytes,d.bytes))) return corrupt();
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
  private async requireSealedFilePublication(tx:Tx,expectedAuthority:AuthorityExpectation,operationId:string,recipientDevice:string) {
    await this.requireAuthority(tx,expectedAuthority);
    const scope=expectedAuthority.scope.id,old=await tx.get(key('projection-publication',scope,operationId));
    if(!old||old.input.expectedAuthority.scope.id!==scope||old.input.operationId!==operationId||
      old.input.nextAuthority.acceptedParent!==expectedAuthority.record?.acceptedParent||
      !old.input.packages.some((p:any)=>p.recipientDevice===recipientDevice)) conflict();
    if(old.input.documentSet){
      if(old.input.documentSet.mode!=='publisher') conflict();
    }else{
      await this.requireSingleHouseholdDocument(tx,scope,[expectedAuthority.record!.acceptedParent]);
    }
    await this.checkProjection(tx,old.input,old.inputKey);
  }
  async readHouseholdSealedFile(expectedAuthority:LocalCommit['expectedAuthority'],operationId:string,recipientDevice:string){expectedAuthority=snapshot(expectedAuthority);if(!validId(operationId)||!validId(recipientDevice))return fail('MALFORMED');try{return await this.run(false,async tx=>{await this.requireSealedFilePublication(tx,expectedAuthority,operationId,recipientDevice);return {ok:true as const,value:snapshot((await tx.get(key('household-sealed-file',expectedAuthority.scope.id,operationId,recipientDevice)))??null)}})}catch(e){return fail(mapError(e))}}
  async commitHouseholdSealedFile(expectedAuthority:LocalCommit['expectedAuthority'],operationId:string,recipientDevice:string,record:any){expectedAuthority=snapshot(expectedAuthority);record=snapshot(record);if(!validId(operationId)||!validId(recipientDevice)||!fields(record,['version','digest','bytes','signature'])||record.version!==1||typeof record.digest!=='string'||!/^[0-9a-f]{64}$/.test(record.digest)||!(record.bytes instanceof Uint8Array)||record.bytes.length<48||record.bytes.length>16*1024*1024+48||!(record.signature instanceof Uint8Array)||record.signature.length!==64)return fail('MALFORMED');try{return await this.run(true,async tx=>{await this.requireSealedFilePublication(tx,expectedAuthority,operationId,recipientDevice);const slot=key('household-sealed-file',expectedAuthority.scope.id,operationId,recipientDevice),old=await tx.get(slot);if(old!==undefined){if(old.digest!==record.digest)conflict();return {ok:true as const,value:{record:snapshot(old),replayed:true}}}await tx.put(slot,record);return {ok:true as const,value:{record:snapshot(record),replayed:false}}})}catch(e){return fail(mapError(e))}}
  async publishProjection(input:ProjectionPublication, rotation?:RotationSourceGuard, selectedSource?:SelectedHouseholdSources):Promise<Result<{replayed:boolean},StorageError>> {
    const inputKey=projectionKey(input); if(inputKey===null)return {ok:false,error:'MALFORMED'}; input=snapshot(input); rotation=rotation&&snapshot(rotation); selectedSource=selectedSource&&snapshot(selectedSource);
    try { return await this.run(true,async tx=>{
      const scope=input.expectedAuthority.scope.id, op=key('projection-publication',scope,input.operationId), old=await tx.get(op);
      if(old) { if(old.inputKey!==inputKey) conflict(); await this.checkProjection(tx,old.input,inputKey); return {ok:true,value:{replayed:true}}; }
      for(const guard of input.guardIds ?? (input.guardId ? [input.guardId] : [])) if(await tx.get(key('pairing-guard',guard))!==undefined) conflict();
      if(input.recovery){const r=input.recovery,checked=await readContinuityHead(tx,scope,r.owner);if(checked.ok===false)return corrupt();const head=checked.value?.head,binding=checked.value?.record,challenge=await tx.get(key('recovery-readmission-challenge',scope,r.claimHash));if(!head||head.generation!==r.generation||head.bindingHash!==r.bindingHash||!binding||binding.bindingHash!==r.bindingHash||binding.binding?.owner!==r.owner||binding.binding?.generation!==r.generation||!challenge||challenge.claimHash!==r.claimHash||challenge.tokenCommitment!==r.tokenCommitment||challenge.sealed!==r.sealed||await tx.get(key('recovery-challenge-consumed',scope,r.claimHash))!==undefined)conflict();}
      await this.requireAuthority(tx,input.expectedAuthority);
      const authority=await tx.get(key('pairing-authority','household',scope));
      if(!authority || authority.revision!==input.expectedAuthority.record!.revision) conflict();
      if(input.documentSet){
        if(rotation || (input.documentSet.mode==='publisher')!==!!selectedSource) conflict();
        await this.requireSingleHouseholdDocument(tx,scope,[input.nextAuthority.acceptedParent]);
        if(await tx.get(key('projection-document-set',scope,input.nextAuthority.acceptedParent))!==undefined) conflict();
        if(selectedSource){
          if(!sameRecord(selectedSource.expectedAuthority,input.expectedAuthority) ||
            !this.matchesRecipeCatalog(selectedSource.binding,input.expectedAuthority)) conflict();
          const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input.manifest.bytes));
          if(selectedSource.catalogRevision+(selectedSource.members?.length??0)!==manifest.catalog.sourceRevision ||
            selectedSource.binding.sourceDocumentId!==manifest.entries[0].sourceDocumentId ||
            (selectedSource.root?.revision??null)!==manifest.entries[0].sourceRevision ||
            manifest.entries.slice(1).some((entry:any)=>![...selectedSource!.entries,...(selectedSource!.members??[])].some(source=>
              source.recipeId===entry.recipeId&&source.documentId===entry.sourceDocumentId&&source.revision===entry.sourceRevision))) conflict();
          await this.requireSelectedHouseholdSources(tx,selectedSource);
        }
      }else{
        if(selectedSource) conflict();
        await this.requireSingleHouseholdDocument(tx,scope,[authority.acceptedParent,input.nextAuthority.acceptedParent]);
      }
      if(rotation) {
        const same=(a:unknown,b:unknown)=>JSON.stringify(projectionCanonical(a))===JSON.stringify(projectionCanonical(b));
        const sourceDocument=input.sourceDocument;
        if(!sourceDocument) return conflict();
        if('reviewId' in rotation &&
           (!same(await tx.get(key('compromise-review',scope,rotation.reviewId)),rotation.review) ||
            !same(await tx.get(key('compromise-frozen-original',scope,rotation.reviewId)),rotation.original))) conflict();
        if(rotation.source &&
           (rotation.source.documentId!==sourceDocument.documentId || rotation.source.revision!==sourceDocument.revision)) conflict();
        const current=await tx.get(key('document',scope,sourceDocument.documentId));
        const owner=await tx.get(key('document-owner',scope,sourceDocument.documentId));
        if(rotation.source ?
          current?.revision!==rotation.source.revision || owner!==authority.acceptedParent || !sameBytes(current.bytes,rotation.source.bytes) :
          current!==undefined || owner!==undefined || sourceDocument.revision!==null) conflict();
      } else if(input.sourceDocument) {
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
      if(input.documentSet&&installed.replayed) conflict();
      if(JSON.stringify(projectionCanonical(installed.record))!==JSON.stringify(projectionCanonical(input.localKey.record))) conflict();
      await tx.put(key('projection-manifest',scope,input.manifest.id),copy(input.manifest.bytes));
      if(input.policySeed)await tx.put(key('projection-policy-seed',scope,input.documents[0].documentId),input.policySeed);
      if(input.seed){const d=input.documents[0].documentId;await tx.put(key('projection-seed',scope,d),input.seed);for(const x of input.seed.identities){await tx.put(key('projection-seed-command',scope,d,x.commandId),input.seed.seedId);await tx.put(key('projection-seed-effect',scope,d,x.effectId),input.seed.seedId);}}
      if(input.documentSet){
        for(const record of input.documentSet.childKeys){
          if((await installLocalKey(tx,record,input.localKey.catalog)).replayed) conflict();
        }
        this.fault?.('projection-set-keys');
        for(const {documentId,seed,policySeed} of input.documentSet.seeds){
          const seedSlot=key('projection-seed',scope,documentId),policySlot=key('projection-policy-seed',scope,documentId);
          if(await tx.get(seedSlot)!==undefined || await tx.get(policySlot)!==undefined) conflict();
          await tx.put(seedSlot,seed);
          if(policySeed){
            await tx.put(policySlot,policySeed);
            for(const policy of (policySeed.bundle as any).policies??[]){
              const slot=key('disclosure-policy-archive',scope,policy.policyHash),previous=await tx.get(slot);
              if(previous===undefined) await tx.put(slot,policy);
              else if(!sameRecord(previous,policy)) conflict();
            }
          }
          for(const identity of seed.identities){
            const command=key('projection-seed-command',scope,documentId,identity.commandId);
            const effect=key('projection-seed-effect',scope,documentId,identity.effectId);
            if(await tx.get(command)!==undefined || await tx.get(effect)!==undefined) conflict();
            await tx.put(command,seed.seedId);
            await tx.put(effect,seed.seedId);
          }
        }
        await tx.put(key('projection-document-set',scope,input.nextAuthority.acceptedParent),
          {manifestId:input.manifest.id,operationId:input.operationId,catalog:input.documentSet.catalog});
        this.fault?.('projection-set-catalog');
      }
      for(const d of input.documents) { await tx.put(key('document-owner',scope,d.documentId),input.nextAuthority.acceptedParent); await tx.put(key('document',scope,d.documentId),{bytes:copy(d.bytes),revision:0}); await tx.put(key('projection-document',scope,d.documentId),{generation:d.generation,operationId:input.operationId}); }
      for(const p of input.packages) { await tx.put(key('projection-package',scope,p.id),copy(p.bytes)); await tx.put(key('projection-outbox',scope,input.operationId,p.id),{packageId:p.id,recipientDevice:p.recipientDevice}); }
      for(const p of input.pendingEdits) await tx.put(key('projection-pending',scope,input.operationId,p.scopeId,p.operationId),inputKey);
      for(const guard of input.guardIds ?? (input.guardId ? [input.guardId] : [])) await tx.put(key('pairing-guard',guard),inputKey);
      if(input.recovery)await tx.put(key('recovery-challenge-consumed',scope,input.recovery.claimHash),inputKey);
      await tx.put(key('pairing-authority','household',scope),input.nextAuthority);
      await tx.put(op,{inputKey,input});
      if(input.documentSet) this.fault?.('projection-set-authority');
      return {ok:true,value:{replayed:false}};
    }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  /** Called only after verifying the signed same-adult transition and source snapshot. */
  async commitHouseholdOwnDevice(input:OwnDevicePublication) {
    const {operationId,guardId,expected,next,source,document,file,sources}=snapshot(input);
    if(!validId(operationId)||!validId(guardId)||!validatePairingAuthority(expected).ok||!validatePairingAuthority(next).ok||
       expected.scope.kind!=='household'||!sameRecord(next.scope,expected.scope)||next.revision!==expected.revision+1||
       expected.acceptedParent===next.acceptedParent||!validId(source?.documentId)||!validId(document?.documentId)||
       !document.documentId.startsWith('paired-')||document.documentId===source.documentId||
       !(document.bytes instanceof Uint8Array)||!document.bytes.length||document.bytes.length>1_048_576||
       !(source.revision===null?source.bytes===null:revision(source.revision)&&source.bytes instanceof Uint8Array)||
       !(file===null||validPairingFile(file))||!denseArray(sources,row=>validId(row.effectId)&&denseArray(row.policyHashes,validId)))return fail('MALFORMED');
    const scope=expected.scope.id;
    try{return await this.run(true,async tx=>{
      const authority=key('pairing-authority','household',scope),op=key('household-own-device',scope,operationId);
      const guard=key('pairing-guard',guardId),owner=key('document-owner',scope,document.documentId);
      const target=key('document',scope,document.documentId),edge=key('household-own-device-parent',scope,document.documentId);
      const current=await tx.get(authority),link={head:expected.acceptedParent,documentId:source.documentId};
      if(!sameRecord(current,expected))conflict();
      await this.requireSingleHouseholdDocument(tx,scope,[expected.acceptedParent,next.acceptedParent]);
      for(const slot of [op,guard,owner,target,edge])if(await tx.get(slot)!==undefined)conflict();
      const old=await this.checkoutDocument(tx,scope,{...link});
      if((old?.revision??null)!==source.revision||!sameRecord(old?.bytes??null,source.bytes))conflict();
      const write=async(slot:string,value:unknown)=>{await tx.put(slot,value);this.fault?.('household-own-device-release')};
      await write(op,{next,guardId,documentId:document.documentId,file});
      await write(guard,op);
      await write(owner,next.acceptedParent);
      await write(target,{bytes:document.bytes,revision:0});
      await write(edge,link);
      await write(key('household-own-device-sources',scope,document.documentId),sources);
      const active=(await tx.get(key('disclosure-active',scope)))??null;
      await write(key('policy-disclosure-head',scope,expected.acceptedParent),active);
      await write(key('policy-disclosure-head',scope,next.acceptedParent),active);
      await write(authority,next);
      return {ok:true as const,value:undefined};
    });}catch(error){return fail(mapError(error));}
  }
  /** Commit a previously verified v5 successor and its complete prepared key set. */
  async commitHouseholdOwnDeviceSet(input:OwnDeviceSetPublication,replayDocuments?:{documentId:string;revision:number;bytes:Uint8Array}[]) {
    input=snapshot(input);
    replayDocuments=snapshot(replayDocuments);
    const {operationId,guardId,expected,next,guard,recipient,copyHash,file,documents}=input;
    const sponsor='sponsor' in input?input.sponsor:undefined;
    if(!validId(operationId)||!validId(guardId)||!validatePairingAuthority(expected).ok||
      !validatePairingAuthority(next).ok||expected.scope.kind!=='household'||!sameRecord(expected.scope,next.scope)||
      next.revision!==expected.revision+1||next.acceptedParent===expected.acceptedParent||!hexOf(copyHash,64)||
      !validPairingFile(file)||
      !denseArray(documents,d=>object(d)&&(d.recipeId===null||validId(d.recipeId))&&validId(d.sourceDocumentId)&&validId(d.documentId)&&
        d.bytes instanceof Uint8Array&&d.bytes.length>0&&d.bytes.length<=MAX_SELECTED_SOURCE_BYTES&&
        denseArray(d.sources,row=>fields(row,['effectId','policyHashes'])&&validId(row.effectId)&&denseArray(row.policyHashes,validId))&&
        (d.policies===undefined||denseArray(d.policies,row=>fields(row,['policyHash','policy','approvals'])&&validId(row.policyHash)&&object(row.policy)&&Array.isArray(row.approvals)))&&
        denseArray(d.identities,row=>fields(row,['effectId','commandId'])&&validId(row.effectId)&&validId(row.commandId))&&
        d.identities.length===d.sources.length&&d.identities.every((row,i)=>row.effectId===d.sources[i].effectId)&&
        validLocalRecord(d.localKey?.record)&&validMasterCatalog(d.localKey?.catalog)&&
        sameRecord(d.localKey.record.identity.scope,expected.scope)&&d.localKey.record.identity.purpose==='data'&&
        (!recipient||d.localKey.record.identity.deviceId===recipient.deviceId))||
      documents.length<1||documents.length>MAX_SELECTED_CHILDREN+1||
      documents.reduce((n,d)=>n+d.bytes.length,0)>MAX_SELECTED_SET_BYTES)return fail('MALFORMED');
    const identities=documents.flatMap(d=>d.identities);
    if(new Set(identities.map(row=>row.commandId)).size!==identities.length||
      new Set(identities.map(row=>row.effectId)).size!==identities.length||
      documents[0].recipeId!==null||documents.slice(1).some(d=>d.recipeId===null||!isRecipeDocumentId(d.documentId))||
      new Set(documents.map(d=>d.recipeId)).size!==documents.length||
      new Set(documents.map(d=>d.documentId)).size!==documents.length||
      documents.some(d=>d.documentId===d.sourceDocumentId)||
      new Set(documents.map(d=>d.sourceDocumentId)).size!==documents.length)return fail('MALFORMED');
    if(recipient){
      if(sponsor!==undefined||!(fields(recipient,['deviceId','fileHash','signature'])&&guard===undefined||
        'kind' in recipient&&(fields(recipient,['deviceId','fileHash','signature','kind','transcriptHash'])||fields(recipient,['deviceId','fileHash','signature','kind','transcriptHash','evidence'])&&validEstablishedEvidence((recipient as any).evidence))&&recipient.kind==='established'&&hexOf(recipient.transcriptHash,64)&&guard!==undefined)||!validId(recipient.deviceId)||
        !hexOf(recipient.fileHash,64)||!hexOf(recipient.signature,128))return fail('MALFORMED');
    }
    if(!recipient||guard){
      if(sponsor!==undefined&&(!validOwnDeviceSetSponsor(sponsor,documents.length)||
        documents.some(d=>d.localKey.record.identity.deviceId!==sponsor.deviceId)))return fail('MALFORMED');
      if(!guard?.expectedAuthority||!this.matchesRecipeCatalog(guard.binding,guard.expectedAuthority)||
        guard.binding.scopeId!==expected.scope.id||guard.binding.branchHead!==expected.acceptedParent||
        !denseArray(guard.entries,entry=>object(entry)&&validId(entry.recipeId))||guard.catalogRevision!==guard.entries.length||
        (guard.members!==undefined&&!denseArray(guard.members,m=>object(m)&&validId(m.recipeId)&&validId(m.documentId)&&revision(m.revision)&&m.bytes instanceof Uint8Array)))return fail('MALFORMED');
      const sources=[{recipeId:null,documentId:guard.binding.sourceDocumentId},
        ...guard.entries.map(e=>({recipeId:e.recipeId,documentId:e.documentId})),
        ...(guard.members??[]).map(e=>({recipeId:e.recipeId,documentId:e.documentId}))];
      if(documents.length!==sources.length||documents.some(d=>!sources.some(s=>s.recipeId===d.recipeId&&s.documentId===d.sourceDocumentId)))return fail('MALFORMED');
    }
    const scope=expected.scope.id;
    try{return await this.run(true,async tx=>{
      const authority=key('pairing-authority','household',scope),op=key('household-own-device-set',scope,operationId),guardSlot=key('pairing-guard',guardId);
      const current=await tx.get(authority),saved=await tx.get(op);
      const mapping=documents.map(({recipeId,sourceDocumentId,documentId})=>({recipeId,sourceDocumentId,documentId}));
      const retained={version:1,next,guardId,copyHash,file,mapping,...(recipient?{expected,recipient}:sponsor?{expected,sponsor}:{})};
      const reservations=documents.flatMap(d=>d.identities.flatMap(row=>[
        key('projection-seed-command',scope,d.documentId,row.commandId),key('projection-seed-effect',scope,d.documentId,row.effectId)
      ]));
      if(saved&&recipient){
        if(replayDocuments?.length!==documents.length)return conflict();
        if(!sameRecord(current,next)||await tx.get(guardSlot)!==op||!sameBytes(saved.file,file)||
          !sameRecord({...saved,file:null},{...retained,file:null}))return conflict();
        for(const [index,d] of documents.entries()){
          const verified=replayDocuments[index],stored=await tx.get(key('document',scope,d.documentId));
          if(verified.documentId!==d.documentId||!stored||stored.revision!==verified.revision||!sameBytes(stored.bytes,verified.bytes))return conflict();
          if((stored.revision===0&&!sameBytes(stored.bytes,d.bytes))||
            await tx.get(key('document-owner',scope,d.documentId))!==next.acceptedParent||
            !sameRecord(await tx.get(key('household-own-device-parent',scope,d.documentId)),{head:expected.acceptedParent,documentId:d.sourceDocumentId})||
            !sameRecord(await tx.get(key('household-own-device-sources',scope,d.documentId)),d.sources)||
            !sameRecord(await findLocalKey(tx,d.localKey.record.operationId,d.localKey.record.identity),d.localKey.record))return corrupt();
          for(const policy of d.policies??[])if(!sameRecord(await tx.get(key('disclosure-policy-archive',scope,policy.policyHash)),policy))return corrupt();
        }
        for(const slot of reservations)if(await tx.get(slot)!==operationId)return corrupt();
        return {ok:true as const,value:{replayed:true}};
      }
      if(!sameRecord(current,expected))conflict();
      if(guard)await this.requireSelectedHouseholdSources(tx,guard);
      for(const slot of [op,guardSlot,...reservations])if(await tx.get(slot)!==undefined)conflict();
      for(const d of documents)for(const slot of [key('document-owner',scope,d.documentId),key('document',scope,d.documentId),key('household-own-device-parent',scope,d.documentId),key('household-own-device-sources',scope,d.documentId)])if(await tx.get(slot)!==undefined)conflict();
      const write=async(slot:string,value:unknown)=>{await tx.put(slot,value);this.fault?.('household-own-device-set')};
      for(const d of documents){
        for(const policy of d.policies??[]){
          const slot=key('disclosure-policy-archive',scope,policy.policyHash),existing=await tx.get(slot);
          if(existing!==undefined&&!sameRecord(existing,policy))conflict();
          if(existing===undefined)await write(slot,policy);
        }
        if((await installLocalKey(tx,d.localKey.record,d.localKey.catalog)).replayed)conflict();
        await write(key('document-owner',scope,d.documentId),next.acceptedParent);
        await write(key('document',scope,d.documentId),{bytes:d.bytes,revision:0});
        await write(key('household-own-device-parent',scope,d.documentId),{head:expected.acceptedParent,documentId:d.sourceDocumentId});
        await write(key('household-own-device-sources',scope,d.documentId),d.sources);
      }
      for(const slot of reservations)await write(slot,operationId);
      await write(op,retained);
      await write(guardSlot,op);
      const active=(await tx.get(key('disclosure-active',scope)))??null;
      await write(key('policy-disclosure-head',scope,expected.acceptedParent),active);
      await write(key('policy-disclosure-head',scope,next.acceptedParent),active);
      await write(authority,next);
      return {ok:true as const,value:{replayed:false}};
    });}catch(error){return fail(mapError(error));}
  }
  async readHouseholdOwnDeviceSetRetained(scope:PairingScope,operationId:string) {
    if(!validPairingScope(scope)||scope.kind!=='household'||!validId(operationId))return fail('MALFORMED');
    try{return await this.run(false,async tx=>{
      const op=key('household-own-device-set',scope.id,operationId),saved=await tx.get(op);
      if(saved===undefined)return {ok:true as const,value:null};
      if((!saved.recipient&&!saved.sponsor)||!sameRecord(saved.expected?.scope,scope)||!sameRecord(saved.next?.scope,scope)||
        !sameRecord(await tx.get(key('pairing-authority','household',scope.id)),saved.next)||
        await tx.get(key('pairing-guard',saved.guardId))!==op||!Array.isArray(saved.mapping)||!validPairingFile(saved.file))return corrupt();
      const documents=[];
      for(const mapping of saved.mapping){
        const {documentId,sourceDocumentId}=mapping;
        const document=await tx.get(key('document',scope.id,documentId));
        const link=await tx.get(key('household-own-device-parent',scope.id,documentId));
        const sources=await tx.get(key('household-own-device-sources',scope.id,documentId));
        if(!document||!sources||!sameRecord(link,{head:saved.expected.acceptedParent,documentId:sourceDocumentId})||
          await tx.get(key('document-owner',scope.id,documentId))!==saved.next.acceptedParent)return corrupt();
        documents.push({...mapping,document,sources});
      }
      return {ok:true as const,value:snapshot({...saved,documents})};
    });}catch(error){return fail(mapError(error));}
  }
  async readHouseholdOwnDeviceSetReceipt(scope:PairingScope,operationId:string) {
    if(!validPairingScope(scope)||scope.kind!=='household'||!validId(operationId))return fail('MALFORMED');
    try{return await this.run(false,async tx=>{
      const op=key('household-own-device-set',scope.id,operationId),saved=await tx.get(op);
      if(saved===undefined)return {ok:true as const,value:null};
      if(!saved.recipient||!sameRecord(saved.expected.scope,scope)||!sameRecord(saved.next.scope,scope)||
        await tx.get(key('pairing-guard',saved.guardId))!==op)return corrupt();
      if(!sameRecord(await tx.get(key('pairing-authority','household',scope.id)),saved.next))return conflict();
      return {ok:true as const,value:snapshot({expected:saved.expected,next:saved.next,recipient:saved.recipient})};
    });}catch(error){return fail(mapError(error));}
  }
  async readHouseholdOwnDeviceRelease(scope:PairingScope,operationId:string,requireCurrent=true) {
    if(!validPairingScope(scope)||scope.kind!=='household'||!validId(operationId))return fail('MALFORMED');
    try{return await this.run(false,async tx=>{
      const op=key('household-own-device',scope.id,operationId),saved=await tx.get(op);
      if(saved===undefined)return {ok:true as const,value:null};
      if(!validatePairingAuthority(saved.next).ok||!sameRecord(saved.next.scope,scope)||!validId(saved.guardId)||
         !validId(saved.documentId)||await tx.get(key('pairing-guard',saved.guardId))!==op||
         await tx.get(key('document-owner',scope.id,saved.documentId))!==saved.next.acceptedParent||
         !(saved.file===null||validPairingFile(saved.file)))return corrupt();
      const current=await tx.get(key('pairing-authority','household',scope.id));
      if(requireCurrent){
        if(!sameRecord(saved.next,current))return conflict();
        await this.requireSingleHouseholdDocument(tx,scope.id,[saved.next.acceptedParent]);
      }
      const sources=await tx.get(key('household-own-device-sources',scope.id,saved.documentId));
      const link=await tx.get(key('household-own-device-parent',scope.id,saved.documentId));
      const document=await tx.get(key('document',scope.id,saved.documentId));
      if(!sources||!link||!document)return corrupt();
      return {ok:true as const,value:snapshot({...saved,sources,link,document})};
    });}catch(error){return fail(mapError(error));}
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
      if(s.kind==='household') await this.requireSingleHouseholdDocument(tx,s.id,[authority.acceptedParent]);
      await tx.put(guard,checked.value); await tx.put(packet,checked.value); await tx.put(outbox,checked.value); await tx.put(op,{inputKey:checked.value,release:r});
      return {ok:true,value:{release:snapshot(r),replayed:false}};
    }); } catch(e) { return fail(mapError(e)); }
  }
  /** The authenticated file and exact source are optional for the earlier
   * key-only caller. A product publication commits both with the successor. */
  async commitPersonalAdmissionRelease(r:PairingRelease,next:PairingAuthorityRecord,publication?:PersonalPairingPublication):Promise<PairingReleaseResult> {
    const checked=pairingReleaseKey(r), valid=validatePairingAuthority(next);
    if(!checked.ok||!valid.ok||r.transcript.action!=='pairOwnDevice'||r.transcript.scope.kind!=='personal'||
      next.scope.kind!=='personal'||next.scope.id!==r.transcript.scope.id||next.revision!==r.expectedAuthorityRevision+1||
      next.acceptedParent!==r.transcript.acceptedParent)return fail('MALFORMED');
    if(publication){
      const {expected,source,file,selection}=publication;
      if(!validatePairingAuthority(expected).ok||!sameRecord(expected.scope,r.transcript.scope)||
        expected.revision!==r.expectedAuthorityRevision||expected.acceptedParent!==r.transcript.acceptedParent||
        expected.authorizationSnapshot!==r.transcript.authorizationSnapshot||!validPairingFile(file)||
        !selection||selection.deviceId!==r.transcript.initiator.deviceId||
        (selection.expected!==null&&(!validPersonalSelection(selection.expected)||selection.expected.scopeId!==r.transcript.scope.id))||
        !source||!validId(source.documentId)||isPolicyDocumentId(source.documentId)||
        !(source.revision===null?source.bytes===null:revision(source.revision)&&source.bytes instanceof Uint8Array&&
          source.bytes.length>0&&source.bytes.length<=2_097_152))return fail('MALFORMED');
    }
    r=snapshot(r);next=snapshot(next);publication=snapshot(publication);
    try{return await this.run(true,async tx=>{
      const s=r.transcript.scope,op=key('pairing-release',s.kind,s.id,r.operationId),guard=key('pairing-guard',r.guard.guardId);
      const packet=key('pairing-packet',s.kind,s.id,r.packet.id),outbox=key('pairing-outbox',s.kind,s.id,r.operationId);
      const transition=key('personal-admission-release',s.id,r.operationId),authorityKey=key('pairing-authority',s.kind,s.id);
      const fileKey=key('personal-pairing-file',s.id,r.operationId),old=await tx.get(op),authority=await tx.get(authorityKey);
      const binding=JSON.stringify(projectionCanonical(next));
      if(old!==undefined){
        if(old.inputKey!==checked.value||await tx.get(transition)!==binding||!sameRecord(authority,next))conflict();
        await this.pairingComplete(tx,old.release,old.inputKey);
        if(publication){const file=await tx.get(fileKey);if(!file||!sameBytes(file,publication.file))conflict();}
        return {ok:true,value:{release:snapshot(old.release),replayed:true}};
      }
      if(authority&&(authority.scope.kind!==s.kind||authority.scope.id!==s.id))corrupt();
      if(!authority||authority.revision!==r.expectedAuthorityRevision||authority.acceptedParent!==r.transcript.acceptedParent||
        authority.authorizationSnapshot!==r.transcript.authorizationSnapshot)conflict();
      for(const slot of [guard,packet,outbox,transition,fileKey])if(await tx.get(slot)!==undefined)conflict();
      if(publication){
        if(!sameRecord(authority,publication.expected)||
          !sameRecord((await tx.get(key('personal-selection',publication.selection.deviceId)))??null,publication.selection.expected))conflict();
        const {source}=publication,doc=await tx.get(key('document',s.id,source.documentId));
        const owner=await tx.get(key('document-owner',s.id,source.documentId));
        if(source.bytes?doc?.revision!==source.revision||owner!==authority.acceptedParent||
          !sameBytes(doc.bytes,source.bytes):doc!==undefined||owner!==undefined)conflict();
        await tx.put(fileKey,publication.file);this.fault?.('personal-admission-release');
      }
      for(const [k,v] of [[guard,checked.value],[packet,checked.value],[outbox,checked.value],[op,{inputKey:checked.value,release:r}],
        [transition,binding],[authorityKey,next]] as const){await tx.put(k,v);this.fault?.('personal-admission-release');}
      return {ok:true,value:{release:snapshot(r),replayed:false}};
    });}catch(e){return fail(mapError(e))}
  }

  async readPersonalPairingFile(next:PairingAuthorityRecord,operationId:string,selection:PersonalPairingPublication['selection']):Promise<Result<Uint8Array,StorageError>> {
    if(!validatePairingAuthority(next).ok||next.scope.kind!=='personal'||!validId(operationId)||!validId(selection?.deviceId)||
      (selection.expected!==null&&(!validPersonalSelection(selection.expected)||selection.expected.scopeId!==next.scope.id)))return {ok:false,error:'MALFORMED'};
    next=snapshot(next);selection=snapshot(selection);
    try{return await this.run(false,async tx=>{
      const {id}=next.scope;
      const authority=await tx.get(key('pairing-authority','personal',id));
      const transition=await tx.get(key('personal-admission-release',id,operationId));
      const selected=(await tx.get(key('personal-selection',selection.deviceId)))??null;
      if(!sameRecord(selected,selection.expected)||!sameRecord(authority,next)||transition!==JSON.stringify(projectionCanonical(next)))return conflict();
      const file=await tx.get(key('personal-pairing-file',id,operationId));
      if(!file)return corrupt();
      return {ok:true,value:snapshot(file)};
    });}catch(e){return {ok:false,error:mapError(e)}}
  }

  async selectOriginalPersonal(deviceId:string,selected:PersonalSelection,original:PairingAuthorityRecord,pin:string):Promise<Result<void,StorageError>> {
    if(!validId(deviceId)||!validPersonalSelection(selected)||!validatePairingAuthority(original).ok||
      original.scope.kind!=='personal'||!hexOf(pin,64)||selected.scopeId===original.scope.id)return {ok:false,error:'MALFORMED'};
    original=snapshot(original);selected=snapshot(selected);
    try{return await this.run(true,async tx=>{
      const slot=key('personal-selection',deviceId);
      if(!sameRecord(await tx.get(slot),selected)||
        !sameRecord(await tx.get(key('pairing-authority','personal',original.scope.id)),original))return conflict();
      // The original root pin is supplied by bootstrap. The selection is always explicit.
      await tx.put(slot,{scopeId:original.scope.id,pin});
      return {ok:true,value:undefined};
    });}catch(e){return {ok:false,error:mapError(e)}}
  }

  async readPersonalSelection(deviceId:string):Promise<Result<PersonalSelection|null,StorageError>> {
    if(!validId(deviceId)) return {ok:false,error:'MALFORMED'};
    try {
      return await this.run(false,async tx=>({ok:true,value:snapshot(await tx.get(key('personal-selection',deviceId)))??null}));
    } catch(e) { return {ok:false,error:mapError(e)}; }
  }

  async readPersonalRotation(scopeId:string,operationId:string):Promise<Result<(PersonalRotationReceipt&{head:string})|null,StorageError>> {
    if(![scopeId,operationId].every(validId)) return {ok:false,error:'MALFORMED'};
    try {
      return await this.run(false,async tx=>{
        const entry=await tx.get(key('personal-rotation',scopeId,operationId));
        if(!entry)return {ok:true,value:null};
        const doc=await tx.get(key('document',scopeId,entry.documentId));
        if(!doc||await tx.get(key('document-owner',scopeId,entry.documentId))!==entry.head) return corrupt();
        return {ok:true,value:snapshot({...entry.receipt,head:entry.head})};
      });
    } catch(e) { return {ok:false,error:mapError(e)}; }
  }

  /** The caller verifies the pinned personal signatures and key/snapshot commitments before publication. */
  async commitPersonalRotation(input:PersonalRotationWrite):Promise<Result<{replayed:boolean},StorageError>> {
    const {expected,next,localKey,source,document,selection,identities,receipt,epochId,operationId,deviceId}=input;
    const scope=next?.scope?.id;
    if(![deviceId,operationId,epochId,scope,document?.id].every(validId) || !validatePairingAuthority(next).ok ||
      next.scope.kind!=='personal' || (expected!==null&&(!validatePairingAuthority(expected).ok||
        expected.scope.id!==scope||expected.scope.kind!=='personal'||next.revision!==expected.revision+1||
        next.acceptedParent===expected.acceptedParent)) ||
      !validLocalRecord(localKey?.record)||!validMasterCatalog(localKey.catalog)||
      !sameRecord(localKey.record.identity,{version:1,scope:next.scope,deviceId,purpose:'data',epochId})||
      !(document.bytes instanceof Uint8Array)||document.bytes.length===0||document.bytes.length>2_097_152||
      !validPersonalReceipt(receipt)||!selection||
      (selection.expected!==null&&!validPersonalSelection(selection.expected))||
      (selection.next!==null&&(!validPersonalSelection(selection.next)||selection.next.scopeId!==scope))||
      !denseArray(identities,x=>fields(x,['commandId','effectId'])&&validId(x.commandId)&&validId(x.effectId))||
      identities.length>4096||new Set(identities.map(x=>x.commandId)).size!==identities.length||
      new Set(identities.map(x=>x.effectId)).size!==identities.length||
      (source?(!expected||!validId(source.documentId)||source.documentId===document.id||
        !(source.revision===null?source.bytes===null:revision(source.revision)&&source.bytes instanceof Uint8Array&&source.bytes.length<=2_097_152)):
        selection.next===null)) return {ok:false,error:'MALFORMED'};
    input=snapshot(input);
    try {
      return await this.run(true,async tx=>{
        const {expected,next,localKey,source,document,selection,identities,receipt}=input;
        const operationKey=key('personal-rotation',scope,operationId), authorityKey=key('pairing-authority','personal',scope);
        const selectionKey=key('personal-selection',deviceId);
        const documentKey=key('document',scope,document.id), ownerKey=key('document-owner',scope,document.id);
        const old=await tx.get(operationKey);
        if(old){
          if(!sameRecord(old.receipt,receipt)||old.epochId!==epochId||
            old.documentId!==document.id||old.head!==next.acceptedParent) conflict();
          const durable=await findLocalKey(tx,localKey.record.operationId,localKey.record.identity);
          if(!durable||!await tx.get(documentKey)||await tx.get(ownerKey)!==next.acceptedParent) corrupt();
          return {ok:true,value:{replayed:true}};
        }
        if(!sameRecord(await tx.get(authorityKey)??null,expected)||
          !sameRecord(await tx.get(selectionKey)??null,selection.expected)) conflict();
        if(source&&expected){
          const stored=await tx.get(key('document',scope,source.documentId));
          const owner=await tx.get(key('document-owner',scope,source.documentId));
          if(source.bytes ? stored?.revision!==source.revision||owner!==expected.acceptedParent||
            !sameBytes(stored.bytes,source.bytes) : stored!==undefined||owner!==undefined) conflict();
        }
        if(await tx.get(documentKey)!==undefined||await tx.get(ownerKey)!==undefined) conflict();
        const installed=await installLocalKey(tx,localKey.record,localKey.catalog);
        if(!sameRecord(installed.record,localKey.record)) conflict();
        for(const {effectId,commandId} of identities){
          const command=key('projection-seed-command',scope,document.id,commandId);
          const effect=key('projection-seed-effect',scope,document.id,effectId);
          if(await tx.get(command)!==undefined||await tx.get(effect)!==undefined) conflict();
          await tx.put(command,operationId);
          await tx.put(effect,operationId);
        }
        await tx.put(documentKey,{bytes:document.bytes,revision:0});
        await tx.put(ownerKey,next.acceptedParent);
        await tx.put(authorityKey,next);
        if(selection.next) await tx.put(selectionKey,selection.next);
        await tx.put(operationKey,{receipt,epochId,documentId:document.id,head:next.acceptedParent});
        return {ok:true,value:{replayed:false}};
      });
    } catch(e) { return {ok:false,error:mapError(e)}; }
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
    for(const command of c.commands)await this.requireUnusedProjectionIdentity(tx,c.scopeId,command,c.expectedAuthority.record?.acceptedParent);
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
  private async requireUnusedProjectionIdentity(tx:Tx,scope:string,command:LocalCommit['commands'][number],head?:string) {
    if (head && command.kind.startsWith('recipe-')) {
      const id = this.storedRecipeId(command);
      const entry = id && await tx.get(key('recipe-catalog',scope,head,id));
      if (entry && entry.documentId !== command.documentId) conflict();
    }
    for(const branch of await this.projectionLineage(tx,scope,command.documentId)){
      if(await tx.get(key('projection-seed-command',scope,branch.documentId,command.commandId))!==undefined||
        await tx.get(key('projection-seed-effect',scope,branch.documentId,command.effectId))!==undefined) conflict();
    }
  }
  private storedRecipeId(command:LocalCommit['commands'][number]) {
    try {
      const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(command.payload));
      return payload.kind===command.kind ? commandRecipeId(payload) : null;
    } catch { return null; }
  }
  private matchesRecipeCatalog(binding:RecipeCatalogBinding,expected:AuthorityExpectation) {
    return validRecipeCatalogBinding(binding) && expected.scope.kind==='household' &&
      binding.scopeId===expected.scope.id && binding.branchHead===expected.record?.acceptedParent;
  }
  private async publishRecipe(tx:Tx,publication:RecipePublication|undefined,c:LocalCommit|ImportCommit,objectId:string,envelope:any) {
    const head=c.expectedAuthority.record?.acceptedParent;
    const installed=head&&await tx.get(key('projection-document-set',c.scopeId,head));
    if(!publication){
      if(envelope.recipeDelivery!==undefined||installed&&c.commands.some(command=>command.kind==='recipe-create'))conflict();
      return;
    }
    const {binding,recipeId,sourceRevision,installedKey}=publication;
    const {header,recipeDelivery}=envelope;
    const [command]=c.commands,[child]=c.documents;
    if (!this.matchesRecipeCatalog(binding,c.expectedAuthority) || !validId(recipeId) || !validId(objectId) ||
        c.commands.length!==1 || c.documents.length!==1 || child.expectedRevision!==null || child.documentId===binding.sourceDocumentId ||
        command.kind!=='recipe-create' || command.documentId!==child.documentId || this.storedRecipeId(command)!==recipeId ||
        header?.documentGeneration!==binding.documentGeneration || header.epochId!==binding.epochId) conflict();
    const source=await this.checkoutDocument(tx,c.scopeId,{head:binding.branchHead,documentId:binding.sourceDocumentId});
    if ((source?.revision??null)!==sourceRevision) conflict();
    const slot=key('recipe-catalog',c.scopeId,binding.branchHead,recipeId);
    if (await tx.get(slot)!==undefined) conflict();
    if (installed) {
      const projected=await tx.get(key('projection-document',c.scopeId,binding.sourceDocumentId));
      if(!installedKey||recipeDelivery?.version!==1||!isRecipeDocumentId(child.documentId)||
         projected?.operationId!==installed.operationId||projected?.generation!==binding.documentGeneration||
         installed.catalog.some((entry:any)=>entry.recipeId===recipeId||entry.documentId===child.documentId||
           entry.documentId===binding.sourceDocumentId))return conflict();
      const {record,catalog}=installedKey,{identity}=record;
      if(identity.scope.kind!=='household'||identity.scope.id!==c.scopeId||identity.purpose!=='data'||
         !denseArray(recipeDelivery.packets,(packet:any)=>Array.isArray(packet)&&packet.length===2&&validId(packet[0]))||
         !recipeDelivery.packets.length||recipeDelivery.packets.length>32||
         ('outbound' in c ? identity.deviceId!==header.authorDevice :
            !recipeDelivery.packets.some((packet:any)=>packet[0]===identity.deviceId)))return conflict();
      await this.requireIncomingAuthor(tx,c.scopeId,identity.deviceId);
      if('outbound' in c){
        for(const [deviceId] of recipeDelivery.packets)await this.requireIncomingAuthor(tx,c.scopeId,deviceId);
      }
      for(const documentId of [binding.sourceDocumentId,...installed.catalog.map((entry:any)=>entry.documentId)]){
        await this.requireUnusedProjectionIdentity(tx,c.scopeId,{...command,documentId});
      }
      if((await installLocalKey(tx,record,catalog)).replayed)conflict();
      this.fault?.('recipe-key');
    }else if(installedKey||recipeDelivery!==undefined)conflict();
    await tx.put(slot,{binding,recipeId,sourceRevision,documentId:child.documentId,effectId:command.effectId,objectId});
    this.fault?.('recipe-catalog');
  }
  async hasSelectedRecipeCatalog(expected:AuthorityExpectation) {
    expected=snapshot(expected);
    if(expected?.scope?.kind!=='household'||!expected.record)return fail('MALFORMED');
    try {
      return await this.run(false,async tx=>{
        await this.requireAuthority(tx,expected);
        return {ok:true as const,value:await hasSelectedRecipeChildren(tx,expected.scope.id,[expected.record!.acceptedParent])};
      });
    }catch(error){return fail(mapError(error));}
  }
  async checkRecipeDeliveryRecipients(expected:AuthorityExpectation,devices:string[]) {
    expected=snapshot(expected);devices=snapshot(devices);
    if(expected?.scope?.kind!=='household'||!expected.record||
       !denseArray(devices,validId)||devices.length<2||devices.length>33||new Set(devices).size!==devices.length)return fail('MALFORMED');
    try{
      return await this.run(false,async tx=>{
        await this.requireAuthority(tx,expected);
        for(const device of devices)await this.requireIncomingAuthor(tx,expected.scope.id,device);
        return {ok:true as const,value:undefined};
      });
    }catch(error){return fail(mapError(error));}
  }
  /** Read index, selected source and child snapshots at one durable revision. */
  async readSelectedRecipeCatalog(expected:AuthorityExpectation,binding:RecipeCatalogBinding,target?:{recipeId:string;documentId:string},maxChildren?:number) {
    expected=snapshot(expected);binding=snapshot(binding);target=snapshot(target);
    if (!expected?.scope || !this.matchesRecipeCatalog(binding,expected) ||
        (maxChildren!==undefined && (!revision(maxChildren)||target!==undefined)) ||
        (target!==undefined&&(!fields(target,['recipeId','documentId'])||!validId(target.recipeId)||!isRecipeDocumentId(target.documentId)))) return fail('MALFORMED');
    try {
      return await this.run(false,async tx=>{
        await this.requireAuthority(tx,expected);
        return {ok:true as const,value:snapshot(await this.selectedRecipeCatalog(tx,expected,binding,target,maxChildren))};
      });
    } catch(e) { return fail(mapError(e)); }
  }
  private async selectedRecipeCatalog(tx:Tx,expected:AuthorityExpectation,binding:RecipeCatalogBinding,
    target?:{recipeId:string;documentId:string},maxChildren?:number) {
    const {scopeId,branchHead,sourceDocumentId}=binding;
    const source=await this.checkoutDocument(tx,scopeId,{head:branchHead,documentId:sourceDocumentId});
    const prefix=key('recipe-catalog',scopeId,branchHead);
    const keys=target ? [] : await tx.keys();
    const slots=target ? [key('recipe-catalog',scopeId,branchHead,target.recipeId)] : keys.filter(k=>k.startsWith(prefix.slice(0,-1)+','));
    let sourceBytes=source?.bytes.length??0;
    if(maxChildren!==undefined && (slots.length>maxChildren || sourceBytes>MAX_SELECTED_SOURCE_BYTES)) {
      throw new StorageFailure('TOO_LARGE');
    }
    const entries:SelectedRecipeSource[]=[];
    for (const slot of slots.sort()) {
      const row=await tx.get(slot);
      if (row===undefined && target) {
        const retained=await this.checkoutDocument(tx,scopeId,{head:branchHead,documentId:target.documentId});
        if (retained) throw new StorageFailure('UNSUPPORTED_VERSION');
        continue;
      }
      if (!row || !this.matchesRecipeCatalog(row.binding,expected) ||
          Object.entries(binding).some(([k,v])=>row.binding[k]!==v) ||
          slot!==key('recipe-catalog',scopeId,branchHead,row.recipeId) ||
          row.documentId===sourceDocumentId || (target&&row.documentId!==target.documentId) ||
          (row.sourceRevision!==null && (!source || row.sourceRevision>source.revision))) return corrupt();
      const child=await this.checkoutDocument(tx,scopeId,{head:branchHead,documentId:row.documentId});
      const proof=await this.validatedDisclosureSource(tx,scopeId,row.effectId);
      if (!child || !proof || proof.objectId!==row.objectId || proof.documentId!==row.documentId || proof.checkpoint!==branchHead) return corrupt();
      sourceBytes+=child.bytes.length+proof.envelope.length;
      if(maxChildren!==undefined && (child.bytes.length>MAX_SELECTED_SOURCE_BYTES || sourceBytes>MAX_SELECTED_SET_BYTES)) {
        throw new StorageFailure('TOO_LARGE');
      }
      entries.push({recipeId:row.recipeId,documentId:row.documentId,effectId:row.effectId,sourceRevision:row.sourceRevision,revision:child.revision,
        bytes:child.bytes,objectId:row.objectId,envelope:proof.envelope});
    }
    if (!target) {
      const children=new Set(entries.map(entry=>entry.documentId));
      const installed=await tx.get(key('projection-document-set',scopeId,branchHead));
      for(const entry of installed?.catalog??[])children.add(entry.documentId);
      const ownerPrefix=key('document-owner',scopeId).slice(0,-1)+',';
      for(const slot of keys) {
        if(!slot.startsWith(ownerPrefix))continue;
        const [, , documentId]=JSON.parse(slot);
        if(documentId!==sourceDocumentId&&isRecipeDocumentId(documentId)&&!children.has(documentId)&&await tx.get(slot)===branchHead) {
          if(!await tx.get(key('document',scopeId,documentId)))return corrupt();
          throw new StorageFailure('UNSUPPORTED_VERSION');
        }
      }
    }
    return {source,entries,catalogRevision:target ? null : slots.length};
  }
  private async requireSelectedHouseholdSources(tx:Tx,observation:SelectedHouseholdSources) {
    const {binding,expectedAuthority,catalogRevision,root,entries,members}=observation;
    await this.requireAuthority(tx,expectedAuthority);
    const current=await this.selectedRecipeCatalog(tx,expectedAuthority,binding,undefined,MAX_SELECTED_CHILDREN);
    const observedRoot=current.source && {...current.source,documentId:binding.sourceDocumentId};
    const comparedEntries = [...entries].sort((a,b)=>a.recipeId<b.recipeId?-1:a.recipeId>b.recipeId?1:0);
    const currentEntries = current.entries.sort((a,b)=>a.recipeId<b.recipeId?-1:a.recipeId>b.recipeId?1:0);
    if(current.catalogRevision!==catalogRevision || !sameRecord(observedRoot,root) ||
      !sameRecord(currentEntries,comparedEntries)) conflict();
    const installed=await tx.get(key('projection-document-set',binding.scopeId,binding.branchHead));
    if (!!installed!==!!members) conflict();
    if(members){
      const catalog=[...installed.catalog].sort((a,b)=>a.recipeId<b.recipeId?-1:a.recipeId>b.recipeId?1:0);
      const observed=[...members].sort((a,b)=>a.recipeId<b.recipeId?-1:a.recipeId>b.recipeId?1:0);
      if(catalog.length!==observed.length)conflict();
      for(const [index,member] of observed.entries()){
        if(!sameRecord(catalog[index],{recipeId:member.recipeId,documentId:member.documentId}) ||
          entries.some(entry=>entry.recipeId===member.recipeId||entry.documentId===member.documentId))conflict();
        const stored=await this.checkoutDocument(tx,binding.scopeId,{head:binding.branchHead,documentId:member.documentId});
        if(!sameRecord(stored,{bytes:member.bytes,revision:member.revision}))conflict();
      }
    }
  }
  /** Use the same check in a publication write transaction to fence projection
   * against both source revisions and catalog insertion. */
  async checkSelectedHouseholdSources(observation:SelectedHouseholdSources) {
    observation=snapshot(observation);
    if(!observation?.expectedAuthority?.scope || !this.matchesRecipeCatalog(observation.binding,observation.expectedAuthority) ||
      !denseArray(observation.entries,entry=>object(entry)&&validId(entry.recipeId)) ||
      observation.entries.length+(observation.members?.length??0)>MAX_SELECTED_CHILDREN || observation.catalogRevision!==observation.entries.length ||
      observation.members!==undefined&&!denseArray(observation.members,member=>object(member)&&validId(member.recipeId)&&validId(member.documentId)&&revision(member.revision)&&member.bytes instanceof Uint8Array)) return fail('MALFORMED');
    try{
      return await this.run(false,async tx=>{
        await this.requireSelectedHouseholdSources(tx,observation);
        return {ok:true as const,value:undefined};
      });
    }catch(e){return fail(mapError(e))}
  }
  private storedShoppingRecipeLink(command:LocalCommit['commands'][number]) {
    if(command.kind!=='shopping-item-create')return null;
    let data:any;
    try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(command.payload))?.data}catch{return null}
    return data?.recipeSource===undefined?null:data;
  }
  private async requireShoppingRecipeSource(
    tx:Tx,c:LocalCommit|ImportCommit,command:LocalCommit['commands'][number],header:any,
    receipts:Map<string,ShoppingRecipeSourceReceipt>,
  ) {
    const sources=new Map<string,{policyHashes:string[],incomplete:boolean}>();
    const data=this.storedShoppingRecipeLink(command);
    if(!data)return sources;
    const claim=data.recipeSource,receipt=receipts.get(command.effectId);
    if(!receipt||!object(claim)||!denseArray(claim.effectIds,validId))return conflict();
    receipts.delete(command.effectId);
    const {binding,recipeId,documentId}=receipt;
    if(!this.matchesRecipeCatalog(binding,c.expectedAuthority)||binding.sourceDocumentId!==command.documentId||
       binding.epochId!==header.epochId||binding.documentGeneration!==header.documentGeneration||
       recipeId!==data.recipeId||documentId!==claim.documentId||!isRecipeDocumentId(documentId))return conflict();
    const root=c.documents.find(doc=>doc.documentId===binding.sourceDocumentId);
    if(!root||root.expectedRevision!==receipt.rootRevision)return conflict();
    const row=await tx.get(key('recipe-catalog',c.scopeId,binding.branchHead,recipeId));
    const installed=await tx.get(key('projection-document-set',c.scopeId,binding.branchHead));
    const admitted=installed?.catalog.find((entry:any)=>entry.recipeId===recipeId);
    let signedMember;
    if(installed){
      const stored=await tx.get(key('projection-manifest',c.scopeId,installed.manifestId));
      const authority=await tx.get(key('pairing-authority','household',c.scopeId));
      const decoder=new TextDecoder('utf-8',{fatal:true});
      let manifest,state;
      try{
        manifest=JSON.parse(decoder.decode(stored));
        state=JSON.parse(decoder.decode(authority.authorityState));
      }catch{return corrupt()}
      if(manifest.version!==5||manifest.householdId!==c.scopeId||manifest.newEpochId!==binding.epochId||
        manifest.newGeneration!==binding.documentGeneration||manifest.entries?.[0]?.documentId!==binding.sourceDocumentId||
        binding.rootPin!==state.root?.head)return conflict();
      signedMember=manifest.entries.find((entry:any)=>entry.recipeId===recipeId);
      if(signedMember?.documentId!==admitted?.documentId)return conflict();
    }
    if(admitted){
      const member=await tx.get(key('projection-document',c.scopeId,documentId));
      if(row||receipt.creationObjectId!==undefined||admitted.documentId!==documentId||
        member?.operationId!==installed.operationId||member?.generation!==binding.documentGeneration)return conflict();
    }else if(!row||row.recipeId!==recipeId||row.documentId!==documentId||row.objectId!==receipt.creationObjectId||
       !sameRecord(row.binding,binding))return conflict();
    const child=await this.checkoutDocument(tx,c.scopeId,{head:binding.branchHead,documentId});
    if(!child||child.revision!==receipt.revision)return conflict();
    const verified=new Map<string,{policyHashes:string[],incomplete:boolean}>();
    if(!denseArray(receipt.effects,effect=>validId(effect?.effectId)&&
      (fields(effect,['effectId','objectId'])&&validId(effect.objectId)||
       fields(effect,['effectId','seedId'])&&validId(effect.seedId))))return conflict();
    for(const effect of receipt.effects){
      const {effectId}=effect;
      if(verified.has(effectId))return conflict();
      if('seedId' in effect){
        const sidecar=await tx.get(key('projection-policy-seed',c.scopeId,documentId));
        const mapping=sidecar?.bundle?.entries?.find((entry:any)=>entry.effectId===effectId);
        if(signedMember?.seedId!==effect.seedId||
          await tx.get(key('projection-seed-effect',c.scopeId,documentId,effectId))!==effect.seedId||
          sidecar?.bundleHash!==signedMember.policyBundleHash||
          sidecar?.bundle?.scopeId!==c.scopeId||sidecar.bundle.seedId!==effect.seedId||
          !denseArray(mapping?.policyHashes,validId))return conflict();
        verified.set(effectId,{policyHashes:mapping.policyHashes,incomplete:true});
      }else{
        const source=await this.validatedDisclosureSource(tx,c.scopeId,effectId);
        if(!source||source.documentId!==documentId||source.objectId!==effect.objectId||source.checkpoint!==binding.branchHead)return conflict();
        verified.set(effectId,{policyHashes:source.policyHashes,incomplete:source.incomplete===true});
      }
    }
    if(row&&!receipt.effects.some(effect=>'objectId' in effect&&effect.effectId===row.effectId&&effect.objectId===row.objectId))return conflict();
    if(admitted&&!receipt.effects.some(effect=>'seedId' in effect))return conflict();
    for(const effectId of claim.effectIds){
      const source=verified.get(effectId);
      if(!source||!command.dependencyEffectIds.includes(effectId))return conflict();
      sources.set(effectId,source);
    }
    return sources;
  }
  /** Dependencies are scope-local and must precede their consumer in the transaction. */
  private async requireDependencies(tx:Tx,scopeId:string,commands:readonly {documentId:string;effectId:string;dependencyEffectIds:readonly string[]}[],
    linked=new Map<string,ReadonlySet<string>>()) {
    const prior=new Set<string>();
    for(const command of commands) {
      for(const dep of command.dependencyEffectIds) if(!prior.has(dep) && !linked.get(command.effectId)?.has(dep) && await tx.get(key('effect',scopeId,dep))===undefined) {
        let found=false;
        for(const branch of await this.projectionLineage(tx,scopeId,command.documentId)){
          if(await tx.get(key('projection-seed-effect',scopeId,branch.documentId,dep))!==undefined){found=true;break;}
        }
        if(!found)conflict();
      }
      prior.add(command.effectId);
    }
  }
  private async local(tx: Tx, c: LocalCommit, inputKey: string, linked?:Map<string,ReadonlySet<string>>) {
    await this.identities(tx,c);
    await this.requireDependencies(tx,c.scopeId,c.commands,linked);
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
  private async ownDeviceSource(tx:Tx,scope:string,documentId:string,effectId:string) {
    for(const branch of await this.projectionLineage(tx,scope,documentId)){
      const rows=await tx.get(key('household-own-device-sources',scope,branch.documentId));
      if(rows===undefined)continue;
      if(!denseArray(rows,row=>validId(row.effectId)&&denseArray(row.policyHashes,validId)))return corrupt();
      const source=rows.find(row=>row.effectId===effectId);
      if(source)return {policyHashes:source.policyHashes,incomplete:true as const};
    }
    return null;
  }
  async readOwnDeviceCookingSource(expected:AuthorityExpectation,documentId:string,effectId:string) {
    try{return await this.run(false,async tx=>{
      await this.requireAuthority(tx,expected);
      return {ok:true as const,value:await this.ownDeviceSource(tx,expected.scope.id,documentId,effectId)};
    });}catch(error){return fail(mapError(error));}
  }
  async readOwnDeviceSourcePolicies(expected:AuthorityExpectation,documentId:string,effectIds:string[]) {
    try{return await this.run(false,async tx=>{
      await this.requireAuthority(tx,expected);
      const value=[];
      for(const effectId of effectIds){
        const policy=await this.disclosureDependency(tx,expected.scope.id,documentId,effectId);
        value.push({effectId,policyHashes:policy.policyHashes});
      }
      return {ok:true as const,value};
    });}catch(error){return fail(mapError(error));}
  }
  private async disclosureDependency(tx:Tx,scope:string,documentId:string,effectId:string,visiting=new Set<string>()):Promise<{policyHashes:string[],incomplete:boolean}>{
    if(visiting.has(effectId)||visiting.size>=256)corrupt();visiting.add(effectId);const copied=await this.ownDeviceSource(tx,scope,documentId,effectId);if(copied)return copied;const source=await this.validatedDisclosureSource(tx,scope,effectId);if(source){
      if(source.documentId!==documentId&&!(await this.projectionLineage(tx,scope,documentId)).some(branch=>branch.documentId===source.documentId))return conflict();
      return {policyHashes:source.policyHashes,incomplete:source.incomplete===true};
    }
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
  async commitLocalWithDisclosurePolicy(c:LocalCommit,policyHash:string|null,expectedActiveHash:string|null=policyHash,publication?:RecipePublication,recipeSources:ShoppingRecipeSourceReceipt[]=[]):Promise<CommitResult> {
    const k=storageOperationKey(c,'local');if(!k.ok)return fail(k.error);if((policyHash!==null&&!validId(policyHash))||(expectedActiveHash!==null&&!validId(expectedActiveHash))||(policyHash!==null&&policyHash!==expectedActiveHash))return fail('MALFORMED');c=snapshot(c);publication=snapshot(publication);recipeSources=snapshot(recipeSources);
    if(c.commands.length!==c.outbound.length)return fail('MALFORMED');
    const allowed=new Set(['recipe-create','recipe-field','recipe-ingredient-add','recipe-ingredient-field','recipe-step-add','recipe-step-field','pantry-create','pantry-field','shopping-list-create','shopping-cycle-start','shopping-item-put','shopping-item-create','shopping-item-field','shopping-list-field','purchase','purchase-correction']);if(c.expectedAuthority.scope.kind!=='household'||c.commands.some(command=>!allowed.has(command.kind)))return fail('MALFORMED');
    try{return await this.run(true,async tx=>{const scope=c.scopeId,head=c.expectedAuthority.record?.acceptedParent;const old=await tx.get(key('local',scope,c.operationId));if(old){if(old.inputKey!==k.value)conflict();for(const command of c.commands){const source=await this.validatedDisclosureSource(tx,scope,command.effectId,policyHash);if(!source||source.commandId!==command.commandId||source.documentId!==command.documentId)conflict()}validateOutcome(old.outcome,c.documents);await this.completedLocal(tx,c,k.value);return {ok:true as const,value:{outcome:old.outcome,replayed:true}}}
      await this.requireAuthority(tx,c.expectedAuthority);if(((await tx.get(key('disclosure-active',scope)))??null)!==expectedActiveHash)conflict();if(expectedActiveHash!==null){const policy=await tx.get(key('disclosure-policy',scope,expectedActiveHash));if(!policy||policy.policyHash!==expectedActiveHash||policy.policy?.scope?.id!==scope||(policyHash!==null&&policy.policy?.checkpoint!==head))conflict()}
      const receipts=new Map(recipeSources.map(source=>[source.consumerEffectId,source]));
      if(receipts.size!==recipeSources.length)conflict();
      const sources=new Map<string,any>(),linkedDependencies=new Map<string,ReadonlySet<string>>();
      for(const [index,command] of c.commands.entries()){
        const {object}=c.outbound[index];
        let h:any;
        try{h=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(object.bytes))?.header}catch{conflict()}
        if((['shopping-item-create','shopping-item-field','shopping-list-field'].includes(command.kind)&&h?.version!==4)||
           ![2,3,4].includes(h?.version)||(h.version===3&&h.disclosureIncomplete!==true||h.version===4&&typeof h.disclosureIncomplete!=='boolean')||
           h.disclosurePolicyHash!==policyHash||h.scopeId!==scope||h.documentId!==command.documentId||h.branchHead!==head||
           JSON.stringify(h.semanticEffectIds)!==JSON.stringify([command.effectId])||
           JSON.stringify(h.sourceEffectIds)!==JSON.stringify([...command.dependencyEffectIds].sort()))conflict();
        const linked=await this.requireShoppingRecipeSource(tx,c,command,h,receipts);
        if(linked.size)linkedDependencies.set(command.effectId,new Set(linked.keys()));
        const policies=new Set<string>(policyHash===null?[]:[policyHash]);
        let incomplete=policyHash===null;
        for(const dep of command.dependencyEffectIds){
          const parent=linked.get(dep)??sources.get(dep)??await this.disclosureDependency(tx,scope,command.documentId,dep);
          incomplete||=parent.incomplete===true;
          for(const hash of parent.policyHashes)policies.add(hash);
        }
        const signedIncomplete=h.version===3||h.version===4&&h.disclosureIncomplete===true;
        const policyHashes=[...policies].sort();
        if(incomplete&&!signedIncomplete||JSON.stringify(h.disclosurePolicyHashes)!==JSON.stringify(policyHashes))conflict();
        sources.set(command.effectId,{policyHashes,checkpoint:head,documentId:command.documentId,commandId:command.commandId,
          envelope:object.bytes,origin:'local',objectId:object.id,...(signedIncomplete?{incomplete:true}:{})});
      }
      if(receipts.size)conflict();
      const outcome=await this.local(tx,c,k.value,linkedDependencies);
      if(publication||c.commands.some(command=>command.kind==='recipe-create')) {
        const object=c.outbound[0].object;
        const envelope=JSON.parse(new TextDecoder().decode(object.bytes));
        await this.publishRecipe(tx,publication,c,object.id,envelope);
      }
      this.fault?.('disclosure-local');for(const [effectId,source] of sources)await tx.put(key('disclosure-source',scope,effectId),source);return {ok:true as const,value:{outcome,replayed:false}}})}catch(e){return fail(mapError(e))}
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
      const staged=new Map<string,any>();for(const c of g.children){await this.requireAuthority(tx,c.expectedAuthority);await this.identities(tx,c);const head=c.expectedAuthority.record?.acceptedParent;if(((await tx.get(key('disclosure-active',scope)))??null)!==expectedActiveHash)conflict();if(expectedActiveHash!==null){const policy=await tx.get(key('disclosure-policy',scope,expectedActiveHash));if(!policy||policy.policyHash!==expectedActiveHash||policy.policy?.scope?.id!==scope||(policyHash!==null&&policy.policy?.checkpoint!==head))conflict()}for(let i=0;i<c.commands.length;i++){const command=c.commands[i];if(this.storedShoppingRecipeLink(command))conflict();const policies=new Set<string>(policyHash===null?[]:[policyHash]);let incomplete=policyHash===null;for(const dep of command.dependencyEffectIds){const earlier=staged.get(dep);if(earlier&&earlier.documentId!==command.documentId)conflict();const parent=earlier??await this.disclosureDependency(tx,scope,command.documentId,dep);incomplete||=parent.incomplete===true;for(const h of parent.policyHashes)policies.add(h)}let header:any;try{header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(c.outbound[i].object.bytes))?.header}catch{conflict()}if(incomplete&&!(header?.version===3||header?.version===4&&header.disclosureIncomplete===true))conflict();const source={policyHashes:[...policies].sort(),checkpoint:head,documentId:command.documentId,commandId:command.commandId,envelope:c.outbound[i].object.bytes,origin:'local',objectId:c.outbound[i].object.id,...(header?.version===3||header?.version===4&&header.disclosureIncomplete===true?{incomplete:true}:{})};let envelope:any;try{envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(source.envelope))}catch{conflict()}const h=envelope?.header;if((['shopping-item-create','shopping-item-field','shopping-list-field'].includes(command.kind)&&h?.version!==4)||![2,3,4].includes(h?.version)||(h.version===3&&h.disclosureIncomplete!==true||h.version===4&&typeof h.disclosureIncomplete!=='boolean')||h.disclosurePolicyHash!==policyHash||h.scopeId!==scope||h.documentId!==command.documentId||h.branchHead!==head||JSON.stringify(h.semanticEffectIds)!==JSON.stringify([command.effectId])||JSON.stringify(h.sourceEffectIds)!==JSON.stringify([...command.dependencyEffectIds].sort())||JSON.stringify(h.disclosurePolicyHashes)!==JSON.stringify(source.policyHashes))conflict();staged.set(command.effectId,source)}}
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
    const store=(this as any).householdRecipient;if(!store)return null;const found=await store.find(scopeId,operationId);if(!found.ok)throw new StorageFailure('CORRUPT');if(!found.value)return null;const p=found.value,checked=await store.check(p);if(!checked.ok||p.documentId!==documentId||(head!==undefined&&p.nextAuthority.acceptedParent!==head))throw new StorageFailure('CORRUPT');return {nextAuthority:p.nextAuthority,manifest:p.manifest,documents:[{documentId:p.documentId,generation:p.generation,bytes:p.snapshot}],seed:p.seed,policySeed:p.policySeed,ownDevice:p.ownDevice};
  }
  async readRetainedProjectionSeed(scopeId:string,documentId:string):Promise<Result<{seed:{seedId:string;identities:{commandId:string;effectId:string}[]};snapshot:Uint8Array;head:string}|null,StorageError>> {
    if(!validId(scopeId)||!validId(documentId))return {ok:false,error:'MALFORMED'};
    try{
      const found=await this.run(false,async tx=>{
        const seed=await tx.get(key('projection-seed',scopeId,documentId)),meta=await tx.get(key('projection-document',scopeId,documentId));
        if(seed===undefined)return null;
        if(!meta||!validId(meta.operationId))return corrupt();
        return {seed:snapshot(seed),operationId:meta.operationId};
      });
      if(!found)return {ok:true,value:null};
      const stored=await this.getProjectionPublication(scopeId,found.operationId);
      if(!stored.ok)return {ok:false,error:'CORRUPT'};
      const publication=stored.value;
      if(!publication){
        const recipient=await this.readRecipientProjection(scopeId,found.operationId,documentId);
        if(!recipient||!sameRecord(recipient.seed,found.seed))return corrupt();
        return {ok:true,value:recipient.ownDevice?.seedSnapshot===null?null:{
          seed:found.seed,snapshot:copy(recipient.ownDevice?.seedSnapshot??recipient.documents[0].bytes),
          head:recipient.nextAuthority.acceptedParent,
        }};
      }
      const documents=publication.documents,set=publication.documentSet;
      const index=set?documents.findIndex(doc=>doc.documentId===documentId):0;
      const document=documents[index];
      const entry=set?.seeds[index];
      if(document?.documentId!==documentId||(!set&&documents.length!==1)||(set&&entry?.documentId!==documentId)||
        !sameRecord(set?entry?.seed:publication.seed,found.seed))return corrupt();
      return {ok:true,value:{seed:found.seed,snapshot:copy(document.bytes),head:publication.nextAuthority.acceptedParent}};
    }catch(e){return {ok:false,error:mapError(e)}}
  }
  private async projectionLineage(tx:Tx,scope:string,documentId:string,head?:string) {
    let current={documentId,head};
    const lineage=[current];
    for(let i=0;i<=128;i++) {
      const policy=isPolicyDocumentId(current.documentId);
      if(policy&&current.head!==undefined&&current.documentId!==`policy-${current.head}`)return corrupt();
      const parent=await tx.get(key(policy?'policy-checkout-parent':'household-own-device-parent',scope,current.documentId));
      if(!parent){
        if(policy)throw new StorageFailure('CHECKOUT_REQUIRED');
        return lineage;
      }
      if(i===128||!validBranchDocument(parent))return corrupt();
      current=parent;
      lineage.push(current);
    }
    return corrupt();
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
      if(!published.ok||!published.value||published.value.nextAuthority.acceptedParent!==origin.head)return fail('CORRUPT');
      const publication=published.value,set=publication.documentSet;
      if(set){
        const index=publication.documents.findIndex(document=>document.documentId===origin.documentId);
        const entry=set.seeds[index];
        if(entry?.documentId!==origin.documentId||!sameRecord(entry.policySeed,sidecar))return fail('CORRUPT');
      }else if(publication.documents.length!==1||publication.documents[0].documentId!==origin.documentId||
        !sameRecord(publication.policySeed,sidecar))return fail('CORRUPT');
      return {ok:true as const,value:{publication,policySeed:sidecar}};
    }catch(e){return fail(mapError(e))}
  }
  async reopenDocument(scopeId: string, documentId: string): Promise<Result<({documentId:string;bytes:Uint8Array;revision:number}) | null,StorageError>> {
    try { return await this.run(false,async tx => { const d = await tx.get(key('document',scopeId,documentId)); return {ok:true,value:d === undefined ? null : {documentId,bytes:copy(d.bytes),revision:d.revision}}; }); } catch(e) { return {ok:false,error:mapError(e)}; }
  }
  /** Keep authenticated historical ciphertext outside the cooking import queue. */
  async holdRevokedEvidence(expected:AuthorityExpectation, object:{id:string;bytes:Uint8Array}):Promise<Result<{replayed:boolean},StorageError>> {
    if(expected?.scope?.kind!=='household'||!validPairingScope(expected.scope)||!expected.record||!validId(object?.id)||
       !(object.bytes instanceof Uint8Array)||!object.bytes.length||object.bytes.length>REVIEW_LIMITS.objectBytes)return {ok:false,error:'MALFORMED'};
    expected=snapshot(expected);object=snapshot(object);
    try{return await this.run(true,async tx=>{
      await this.requireAuthority(tx,expected);
      const scope=expected.scope.id, prefix=key('cursor',scope).slice(0,-1)+',"revoked:',
        slot=key('cursor',scope,`revoked:${object.id}`), inbox=key('inbox',scope,object.id);
      const old=await tx.get(inbox), saved=await tx.get(slot);
      if(old&&!sameBytes(old.bytes,object.bytes))return conflict();
      if(saved!==undefined){
        if(saved!==object.id||!old)return corrupt();
        return {ok:true as const,value:{replayed:true}};
      }
      const keys=(await tx.keys()).filter(value=>value.startsWith(prefix));
      if(keys.length>=REVIEW_LIMITS.objects)return {ok:false as const,error:'CAPACITY' as const};
      let total=object.bytes.length;
      for(const entry of keys){
        const id=await tx.get(entry), prior=await tx.get(key('inbox',scope,id));
        if(entry!==key('cursor',scope,`revoked:${id}`)||!prior)return corrupt();
        total+=prior.bytes.length;
        if(total>REVIEW_LIMITS.bytes)return {ok:false as const,error:'CAPACITY' as const};
      }
      if(!old)await tx.put(inbox,{bytes:object.bytes});
      await tx.put(slot,object.id);
      return {ok:true as const,value:{replayed:false}};
    });}catch(e){return {ok:false,error:mapError(e)};}
  }
  async readRetainedBranch(expected:AuthorityExpectation,location:BranchDocument):Promise<Result<{bytes:Uint8Array;revision:number}|null,StorageError>> {
    if(expected?.scope?.kind!=='household'||!validPairingScope(expected.scope)||!expected.record||!validBranchDocument(location))return {ok:false,error:'MALFORMED'};
    expected=snapshot(expected);location=snapshot(location);
    try{return await this.run(false,async tx=>{
      await this.requireAuthority(tx,expected);
      const document=await this.checkoutDocument(tx,expected.scope.id,location);
      return {ok:true as const,value:snapshot(document)};
    });}catch(e){return {ok:false,error:mapError(e)};}
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
  async commitImportWithDisclosurePolicy(c:ImportCommit,header:any,verified:{objectId:string,bytes:Uint8Array},expectedActiveHash:string|null=header.disclosurePolicyHash,publication?:RecipePublication,recipeSources:ShoppingRecipeSourceReceipt[]=[]):Promise<CommitResult> {
    const k=storageOperationKey(c,'import');if(!k.ok)return fail(k.error);c=snapshot(c);header=snapshot(header);verified=snapshot(verified);publication=snapshot(publication);recipeSources=snapshot(recipeSources);if(!verified||verified.objectId!==c.itemId||!(verified.bytes instanceof Uint8Array)||c.commands.length!==1||(['shopping-item-create','shopping-item-field','shopping-list-field'].includes(c.commands[0].kind)&&header?.version!==4)||!['recipe-create','recipe-field','recipe-ingredient-add','recipe-ingredient-field','recipe-step-add','recipe-step-field','pantry-create','pantry-field','shopping-list-create','shopping-cycle-start','shopping-item-put','shopping-item-create','shopping-item-field','shopping-list-field','purchase','purchase-correction'].includes(c.commands[0].kind)||c.expectedAuthority.scope.kind!=='household'||!object(header)||![2,3,4].includes(header.version)||(header.version===3&&header.disclosureIncomplete!==true||header.version===4&&typeof header.disclosureIncomplete!=='boolean')||!(validId(header.disclosurePolicyHash)||((header.version===3||header.version===4&&header.disclosureIncomplete)&&header.disclosurePolicyHash===null))||!(expectedActiveHash===null||validId(expectedActiveHash))||!denseArray(header.disclosurePolicyHashes,validId)||!denseArray(header.sourceEffectIds,validId))return fail('MALFORMED');
    try{return await this.run(true,async tx=>{const scope=c.scopeId,head=c.expectedAuthority.record?.acceptedParent,command=c.commands[0],inbox=await tx.get(key('inbox',scope,c.itemId));if(!inbox||!sameBytes(inbox.bytes,verified.bytes))conflict();let staged:any;try{staged=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(inbox.bytes))}catch{conflict()}if(JSON.stringify(staged.header)!==JSON.stringify(header))conflict();if(header.scopeId!==scope||header.documentId!==command.documentId||header.branchHead!==head||JSON.stringify(header.semanticEffectIds)!==JSON.stringify([command.effectId])||JSON.stringify(header.sourceEffectIds)!==JSON.stringify([...command.dependencyEffectIds].sort()))conflict();
      const op=key('import',scope,c.operationId),old=await tx.get(op);if(old){if(old.inputKey!==k.value||!old.outcome)conflict();await this.completedImport(tx,c,k.value);const prior=await this.validatedDisclosureSource(tx,scope,command.effectId);if(!prior||prior.commandId!==command.commandId||prior.objectId!==verified.objectId||!sameBytes(prior.envelope,verified.bytes)||JSON.stringify(prior.policyHashes)!==JSON.stringify(header.disclosurePolicyHashes))conflict();validateOutcome(old.outcome,c.documents);return {ok:true as const,value:{outcome:old.outcome,replayed:true}}}
      await this.requireAuthority(tx,c.expectedAuthority);await this.requireIncomingAuthor(tx,scope,header.authorDevice);if(await tx.get(key('applied',scope,c.itemId))!==undefined)conflict();if(((await tx.get(key('disclosure-active',scope)))??null)!==expectedActiveHash)conflict();if((header.version===2||header.version===4&&!header.disclosureIncomplete)&&expectedActiveHash!==header.disclosurePolicyHash)conflict();if(expectedActiveHash!==null){const activePolicy=await tx.get(key('disclosure-policy',scope,expectedActiveHash));if(!activePolicy||activePolicy.policyHash!==expectedActiveHash||activePolicy.policy?.scope?.id!==scope||((header.version===2||header.version===4&&!header.disclosureIncomplete)&&activePolicy.policy?.checkpoint!==head))conflict()}
      const receipts=new Map(recipeSources.map(source=>[source.consumerEffectId,source]));
      if(receipts.size!==recipeSources.length)conflict();
      const linked=await this.requireShoppingRecipeSource(tx,c,command,header,receipts);
      if(receipts.size)conflict();
      const policies=new Set<string>(header.disclosurePolicyHash===null?[]:[header.disclosurePolicyHash]);
      let incomplete=header.disclosurePolicyHash===null;
      for(const dep of command.dependencyEffectIds){
        const parent=linked.get(dep)??await this.disclosureDependency(tx,scope,command.documentId,dep);
        incomplete||=parent.incomplete===true;
        for(const hash of parent.policyHashes)policies.add(hash);
      }
      const signedIncomplete=header.version===3||header.version===4&&header.disclosureIncomplete===true;
      if(incomplete&&!signedIncomplete)conflict();
      const source={policyHashes:[...policies].sort(),checkpoint:head,documentId:command.documentId,commandId:command.commandId,
        envelope:inbox.bytes,origin:'import',objectId:c.itemId,...(signedIncomplete?{incomplete:true}:{})};
      if(JSON.stringify(source.policyHashes)!==JSON.stringify(header.disclosurePolicyHashes))conflict();
      if(await tx.get(key('command',scope,command.commandId))!==undefined||await tx.get(key('effect',scope,command.effectId))!==undefined)conflict();await this.requireUnusedProjectionIdentity(tx,scope,command,head);await this.requireDependencies(tx,scope,c.commands,new Map([[command.effectId,new Set(linked.keys())]]));const outcome=await this.documents(tx,scope,c.documents,head??null);
      if(publication||command.kind==='recipe-create'||staged.recipeDelivery!==undefined)
        await this.publishRecipe(tx,publication,c,c.itemId,staged);
      this.fault?.('import-documents');await tx.put(key('command',scope,command.commandId),k.value);await tx.put(key('effect',scope,command.effectId),k.value);await tx.put(key('disclosure-source',scope,command.effectId),source);await tx.put(key('applied',scope,c.itemId),c.operationId);await tx.put(op,{inputKey:k.value,outcome});this.fault?.('import');return {ok:true as const,value:{outcome,replayed:false}}})}catch(e){return fail(mapError(e))}
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
        await this.requireUnusedProjectionIdentity(tx,c.scopeId,command,c.expectedAuthority.record?.acceptedParent);
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
