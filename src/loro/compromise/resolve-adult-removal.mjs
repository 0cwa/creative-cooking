import {reopenAdultRemovalSponsor} from './release-adult-removal.mjs';
import {verifyRetainedAdultRemovalRecipient} from './reopen-adult-removal.mjs';

/** Read-only receipt resolution; this does not enable ordinary authority or runtime. */
export async function resolveAdultRemovalReceipt({role,deviceId,...options}) {
 if(role==='sponsor')return reopenAdultRemovalSponsor({...options,deviceId});
 if(role==='recipient')return verifyRetainedAdultRemovalRecipient({...options,recipientDeviceId:deviceId});
 throw Error('INVALID_RECIPIENT');
}
