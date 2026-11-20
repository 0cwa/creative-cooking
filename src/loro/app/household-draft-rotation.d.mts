import type {PairingAuthorityRecord,PairingScope} from '../contracts/pairing.ts';
import type {OfflineRuntime} from '../engine/runtime.mjs';
import type {LocalKeys} from '../storage/local-keys.ts';

type Voter = {adultId:string;deviceId:string};
export type DraftRotationRecipientBinding = {
 version:1;scopeId:string;parentHead:string;deviceId:string;wrappingKey:string;signature:string;
};
type Event = {
 version:2;kind:'revokeDevice';householdId:string;parentHead:string;proposalId:string;authorDeviceId:string;
 policyHash:string;generation:number;epochId:string;suiteId:string;frozenAdultRoster:string[];nextPolicy:null;
 subject:{deviceId:string;documentId:string;newGeneration:number;newEpochId:string;
 devices:{deviceId:string;signingKeyRef:string;wrappingKeyRef:string;peerId:string}[]};
};
type Approval = Voter & {version:1;householdId:string;eventHash:string;parentHead:string;policyHash:string;generation:number;epochId:string;signature:string};
export type DraftRotationProposal = {
 item:{event:Event;authorSignature:string;approvals:Approval[]};
 grant:{version:1;householdId:string;parentHead:string;eventHash:string;manifestHash:string;
  newEpochId:string;newGeneration:number;documentId:string;recipients:string[];packageRefs:string[];
  contentClasses:string[];disclosure:'current-state-only';signatures:(Voter & {signature:string})[]};
 manifest:{version:7;rootPin:string;householdId:string;parentHead:string;authorizationSnapshot:string;
  revocationEventHash:string;newDocumentId:string;newEpochId:string;newGeneration:number;sourceSetHash:string;
  draftBindingHash:string;catalog:{sourceRevision:number;sourceHash:string;targetRevision:number;removed:string[]};
  entries:{recipeId:string|null;sourceDocumentId:string;sourceRevision:number|null;sourceHash:string|null;
   documentId:string;snapshotHash:string;policyBundleHash:string|null;seedId:string;peerId:string}[]};
 recipientBindings:DraftRotationRecipientBinding[];
};
export type DraftRotationReview = {
 eventHash:string;manifestHash:string;grantHash:string;confirmation:string;parentHead:string;suspectDevice:string;
 recipients:string[];approved:Voter[];approvals:number;required:number;complete:boolean;canApprove:boolean;
};
type ProposalInput = {proposal:DraftRotationProposal;publisherParent?:PairingAuthorityRecord};
type Prepared = DraftRotationReview & {proposal:DraftRotationProposal;publisherParent:PairingAuthorityRecord};
type FileReview = Pick<DraftRotationReview,'eventHash'|'grantHash'|'confirmation'|'parentHead'|'suspectDevice'> &
 {operationId:string;sourceRevision:number};

export function householdDraftRotation(options:{
 storage:OfflineRuntime['storage'];scope:PairingScope;pin:string;provider:OfflineRuntime['authority']['provider'];
 sodium:{randombytes_buf(size:number):Uint8Array;crypto_generichash(size:number,bytes:Uint8Array):Uint8Array;
  crypto_sign_detached(bytes:Uint8Array,secret:Uint8Array):Uint8Array};
 runtime:OfflineRuntime;deviceId:string;adultId:string;signingKey:string;
 randomUUID:()=>string;revocation:{binding():Promise<DraftRotationRecipientBinding>};
 keys:LocalKeys;LoroDoc:OfflineRuntime['LoroDoc'];
 withSecrets:<T>(use:(keys:{signingSecret:Uint8Array;wrappingSecret:Uint8Array})=>Promise<T>)=>Promise<T>;
}):{
 binding():Promise<DraftRotationRecipientBinding>;
 prepare(input:{draftId:string;bindings:DraftRotationRecipientBinding[];explicit:boolean}):Promise<Prepared>;
 review(input:ProposalInput):Promise<DraftRotationReview>;
 approve(input:ProposalInput & {confirmed:string;explicit:boolean}):Promise<Prepared>;
 publish(input:{draftId:string;proposal:DraftRotationProposal;confirmed:string;explicit:boolean}):Promise<{operationId:string;head:string}>;
 status(operationId?:string):Promise<{operationId:string;head:string;recipients:string[]}>;
 exportFile(input:{operationId:string;recipientDeviceId:string}):Promise<Uint8Array>;
 reviewFile(input:{file:Uint8Array}):Promise<FileReview>;
 install(input:{file:Uint8Array;confirmed:string;sourceRevision:number;explicit:boolean}):Promise<{head:string}>;
};
