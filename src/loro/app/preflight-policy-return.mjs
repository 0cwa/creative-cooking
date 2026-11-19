import {domain} from '../authority/validator.mjs';
import {readVerifiedActivatedPolicyDocumentSet} from './read-activated-policy-document-set.mjs';

/** Read-only preflight. Pointers remain untrusted until their lineage is verified. */
export async function preflightPolicyReturn({expectedTargetHead,expectedTargetRevision,...args}) {
 if (expectedTargetHead!==args.targetHead || !Number.isSafeInteger(expectedTargetRevision)) throw Error('STALE_TARGET');
 const activation=await readVerifiedActivatedPolicyDocumentSet(args);
 if (activation.record.revision!==expectedTargetRevision) throw Error('STALE_TARGET');
 const pointers=await args.storage.readPolicyReturnPointers(args.scope.id,args.targetHead);
 if (!pointers.ok) throw Error(pointers.error.code);
 const current=await args.storage.readPairingAuthority(args.scope);
 if (!current.ok) throw Error('STALE_TARGET');
 const a=domain('policy-return-record',current.value), b=domain('policy-return-record',activation.record);
 if (!current.ok || a.length!==b.length || !a.every((byte,i)=>byte===b[i])) throw Error('STALE_TARGET');
 return {sourceHead:activation.sourceHead,targetHead:activation.targetHead,pointers:pointers.value};
}
