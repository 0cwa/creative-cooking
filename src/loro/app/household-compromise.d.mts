import type {OfflineRuntime} from '../engine/runtime.mjs';

type Confirmation = {
  scopeId:string;
  selectionRevision:number;
  record:{revision:number;acceptedParent:string;authorizationSnapshot:string};
};
type Operation = {objectId:string;authorDevice:string;effectId:string;kind:string;sourceHead:string};
type Boundary = {kind:'checkpoint'} | {kind:'operation';ref:string};
type Draft = {suspectDevice:string;operations:Operation[];checkpoint:string|null;checkpointOversized:boolean;excluded:number;truncated:boolean};
type Outcome = {objectId?:string;authorDevice?:string;effectId?:string;sourceHead?:string;reason?:string;kind?:string};
type SelectedOperation = Omit<Operation,'sourceHead'> & {documentId:string;recipeId:string|null};
type SelectedBoundary = {documentId:string;objectId:string};
type SelectedPlan = {suspectDevice:string;operations:SelectedOperation[];excluded:number;truncated:boolean};
type SelectedReport = {reportHash:string;reporterDevice:string;suspectDevice:string;boundary:SelectedBoundary;operations:SelectedOperation[]};
type SelectedDraft = {
  draftId:string;
  reportHash:string;
  selectedEffectIds:string[];
  complete:false;
  rows:{documentId:string;recipeId:string|null;objectId:string;effectId:string;authorDevice:string;
    authorship:'suspect'|'other';status:'retained'|'excluded'|'held';reason:string}[];
  pantry:string[];
  recipes:string[];
  shopping:string[];
};
type Review = {
  reviewId:string;
  reporterDevice:string;
  suspectDeviceIds:string[];
  boundary:Boundary;
  checkpointLabel?:string;
  checkpointUnavailable:boolean;
  rows:(Operation & {boundary:boolean;selectable:boolean;category:'suspect'|'dependent'|'other'|'uncertain'|'outside';missingDependencies:number})[];
  missing:{objectId:string}[];
  count:number;
  unsupported:boolean;
  legacyLineage:boolean;
  canSave:boolean;
  draft:null|{documentId:string;included:Outcome[];excluded:Outcome[];held:Outcome[];pantry:string[];recipes:string[];shopping:string[]};
};
export function householdCompromise(options:{
  runtime:OfflineRuntime;
  withCurrent:<T>(use:(selectionRevision:number)=>Promise<T>)=>Promise<T>;
  sha256?:(bytes:Uint8Array)=>Promise<string>;
  randomUUID?:()=>string;
  randomBytes?:(size:number)=>Uint8Array;
}): {
  selected:{
    open():Promise<{confirmation:Confirmation;reportHashes:string[];draftIds:string[]}>;
    prepare(confirmation:Confirmation,suspectDevice:string):Promise<SelectedPlan>;
    sign(plan:SelectedPlan,decision:SelectedBoundary & {suspectDevice:string}):Promise<{reportHash:string;replayed:boolean}>;
    inspect(confirmation:Confirmation,reportHash:string):Promise<SelectedReport>;
    saveDraft(confirmation:Confirmation,reportHash:string,selectedEffectIds:string[]):Promise<{draftId:string;replayed:boolean}>;
    reopenDraft(confirmation:Confirmation,draftId:string):Promise<SelectedDraft>;
  };
  open():Promise<{confirmation:Confirmation;reports:{reviewId:string}[]}>;
  devices(confirmation:Confirmation):Promise<string[]>;
  prepare(confirmation:Confirmation,suspectDevice:string):Promise<Draft>;
  sign(draft:Draft,boundary:Boundary):Promise<string>;
  receive(confirmation:Confirmation,file:Uint8Array):Promise<{reviewId:string;replayed:boolean}>;
  inspect(confirmation:Confirmation,reviewId:string):Promise<Review>;
  saveCleanDraft(review:Review,selectedEffectIds:string[]):Promise<Review>;
  share(confirmation:Confirmation,reviewId:string,handoff:(file:Uint8Array)=>Promise<void>):Promise<void>;
};
