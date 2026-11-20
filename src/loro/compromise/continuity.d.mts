import type {TransactionRunner} from '../storage/core.ts';
export class ContinuityRegistry {
 constructor(run:TransactionRunner,fault?:(boundary:string)=>void);
 register(input:Record<string,any>):Promise<{bindingHash:string;replayed:boolean}>;
 current(input:Record<string,any>):Promise<any>;
}
