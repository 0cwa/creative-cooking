import type {PairingAuthorityRecord,PairingScope} from '../contracts/pairing.ts';
import type {OfflineRuntime} from '../engine/runtime.mjs';

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

export function householdDraftRotation(options:{
 storage:OfflineRuntime['storage'];scope:PairingScope;pin:string;provider:OfflineRuntime['authority']['provider'];
 sodium:{randombytes_buf(size:number):Uint8Array};runtime:OfflineRuntime;deviceId:string;adultId:string;signingKey:string;
 randomUUID:()=>string;revocation:{binding():Promise<DraftRotationRecipientBinding>};
}):{
 binding():Promise<DraftRotationRecipientBinding>;
 prepare(input:{draftId:string;bindings:DraftRotationRecipientBinding[];explicit:boolean}):Promise<Prepared>;
 review(input:ProposalInput):Promise<DraftRotationReview>;
 approve(input:ProposalInput & {confirmed:string;explicit:boolean}):Promise<Prepared>;
};
