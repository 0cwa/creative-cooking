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
type Review = {
  reviewId:string;
  reporterDevice:string;
  suspectDeviceIds:string[];
  boundary:Boundary;
  checkpointLabel?:string;
  checkpointUnavailable:boolean;
  rows:(Operation & {boundary:boolean;selectable:boolean;category:'suspect'|'dependent'|'other'|'uncertain';missingDependencies:number})[];
  missing:{objectId:string}[];
  count:number;
  unsupported:boolean;
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
  open():Promise<{confirmation:Confirmation;reports:{reviewId:string}[]}>;
  devices(confirmation:Confirmation):Promise<string[]>;
  prepare(confirmation:Confirmation,suspectDevice:string):Promise<Draft>;
  sign(draft:Draft,boundary:Boundary):Promise<string>;
  receive(confirmation:Confirmation,file:Uint8Array):Promise<{reviewId:string;replayed:boolean}>;
  inspect(confirmation:Confirmation,reviewId:string):Promise<Review>;
  saveCleanDraft(review:Review,selectedEffectIds:string[]):Promise<Review>;
  share(confirmation:Confirmation,reviewId:string,handoff:(file:Uint8Array)=>Promise<void>):Promise<void>;
};
