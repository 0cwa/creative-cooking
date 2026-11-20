import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {reopenDraftRotationSponsor} from './release-draft-rotation.mjs';
import {verifyRetainedDraftRotationRecipient} from './reopen-draft-rotation.mjs';

/** Resolve the local receipt without exposing its ciphertext or wrapping key. */
export async function resolveDraftRotationReceipt({role,deviceId,...options}) {
 if(role==='sponsor')return reopenDraftRotationSponsor({...options,deviceId});
 if(role!=='recipient')throw Error('INVALID_RECIPIENT');
 const {storage,scope,operationId,pin,provider}=options;
 const saved=await storage.readDraftRotationRecipient(scope.id,operationId);
 if(!saved.ok||!saved.value||saved.value.recipientDeviceId!==deviceId)throw Error('INVALID_RECEIPT');
 const parentStore={readPairingAuthority:async()=>({ok:true,value:saved.value.expected})};
 const {state,nodes}=await verifyPublicParent(parentStore,scope,pin,provider);
 const recipient=nodes.get(state.activeHead)?.devices.find(device=>device.active&&device.deviceId===deviceId);
 if(!recipient)throw Error('INVALID_RECIPIENT');
 return verifyRetainedDraftRotationRecipient({...options,recipientDeviceId:deviceId,recipientAdultId:recipient.adultId});
}
