import {durableSession} from '../pairing/durable-session.mjs';

/** Session actions obtain device secrets only inside the wrapped catalog's
 * closures. Confirmation must be collected independently by the caller. */
export function householdSession({sodium,store,keys,signing,wrapping,transcript,guard,role,oob,confirmedHash}:any) {
 if(typeof confirmedHash!=='string'||!oob||confirmedHash!==oob.hash)throw Error('OOB_REQUIRED');
 const t=structuredClone(transcript),g=structuredClone(guard),pins=structuredClone(oob);
 const act=(method:string,...args:any[])=>keys.use(signing.operationId,signing.identity,(signingSecret:Uint8Array)=>keys.use(wrapping.operationId,wrapping.identity,(wrappingSecret:Uint8Array)=>(durableSession(sodium,store,{signingSecret,wrappingSecret},t,g,role,pins) as any)[method](...args)));
 return {initialize:()=>act('initialize'),respond:(offer:any,revision:number)=>act('respond',structuredClone(offer),revision),acknowledge:(response:any,revision:number)=>act('acknowledge',structuredClone(response),revision),finish:(ack:any,revision:number)=>act('finish',structuredClone(ack),revision),status:()=>act('status'),evidence:()=>act('evidence')};
}
