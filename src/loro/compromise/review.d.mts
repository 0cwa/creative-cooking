import type {TransactionRunner} from '../storage/core.ts';
export const REVIEW_LIMITS: Readonly<{objects:number;bytes:number;objectBytes:number;dependencies:number;authorityHeads:number}>;
import type {LocalCommit} from '../contracts/index.ts';
export function readLocalQuarantine(tx:{get(key:string):Promise<unknown>},scopeId:string,deviceId:string):Promise<boolean>;
export class CompromiseReviews {
 constructor(run:TransactionRunner,fault?:(boundary:string)=>void);
 quarantine(scopeId:string,deviceId:string,guard?:{expectedAuthority:LocalCommit['expectedAuthority'];localDeviceId:string}):Promise<{quarantined:boolean}>;
 isQuarantined(scopeId:string,deviceId:string):Promise<boolean>;
 stageEvidence(input:{scopeId:string;sourceId:string;objectId:string;bytes:Uint8Array}):Promise<{accepted:boolean;reason?:string;replayed?:boolean}>;
 freeze(input:Record<string,any>):Promise<any>;
 get(scopeId:string,reviewId:string):Promise<any>;
 inspectOriginal(scopeId:string,reviewId:string):Promise<any>;
 noteRejected(scopeId:string,sourceId:string,reason:string):Promise<boolean>;
 classify(scopeId:string,reviewId:string,items:any[]):Promise<any>;
 select(scopeId:string,reviewId:string,effects:string[]):Promise<any>;
 prepareCurrentSeed(input:Record<string,any>):Promise<any>;
 finalizeHistorical(input:Record<string,any>):Promise<any>;
}
