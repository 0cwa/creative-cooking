import {verifyAuthority} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {digest, encode, exact, hex, revocationPackage, verifyRevocationSeed, verifySignature} from '../compromise/revocation.mjs';
import {verifyStoredKeyPackage} from './key-package.mjs';
import {verifyPublicParent} from './household-recipient-proof.mjs';

export async function verifyRotationPayload({sodium,provider,LoroDoc,parent,item,recipientDevice,documentId,generation,manifest,seed,snapshot,packet}) {
  const rotation=item.rotation, m=rotation.manifest;
  if (rotation.grant.version!==2 || documentId!==m.newDocumentId || generation!==m.newGeneration ||
      manifest?.id!==rotation.grant.manifestHash || !(manifest.bytes instanceof Uint8Array) ||
      hex(manifest.bytes)!==hex(encode(m))) throw Error('INVALID_MANIFEST');
  await verifyRevocationSeed({provider,LoroDoc,parent,item,manifest:m,snapshot,seed});
  const recipient=await revocationPackage({provider,parent,item,recipientDevice});
  verifyStoredKeyPackage(sodium,packet,recipient.context);
  return recipient;
}

export async function verifyRevocationRecipient({
  sodium,storage,scope,pin,provider,keys,recipientDevice,publication:p,seed,confirmedEventHash,confirmedGrantHash,LoroDoc,savedSelection,recipientKind,confirmedClaimHash,confirmedDecisionHash
}) {
  if (!exact(p,'item,selection,admissionEventHash,grantHash,manifest,document,packet') ||
      !exact(p.document,'documentId,generation,bytes') || !exact(seed,'seedId,identities') ||
      confirmedEventHash!==p.admissionEventHash) throw Error('INVALID_FILE');
  const {record,state,nodes}=await verifyPublicParent(storage,scope,pin,provider);
  const item=p.item, parent=nodes.get(state.activeHead);
  const recovery=item?.event?.kind==='recoverDevice', fresh=recovery&&item.event.subject.deviceId===recipientDevice;
  if((recipientKind==='recovery')!==recovery || fresh&&confirmedClaimHash!==item.event.subject.claimHash)throw Error('INVALID_RECOVERY_PROOF');
  if(recovery){
   const {event,approvals,authorSignature,rotation:{grant,manifest,recipientBindings,recoveryProof}}=item;
   const decision={item:{event,approvals,authorSignature},grant,manifest,recipientBindings,recoveryProof};
   if(await digest(provider,'recovery-file-decision',decision)!==confirmedDecisionHash)throw Error('INVALID_RECOVERY_PROOF');
  }
  if (item?.event?.parentHead!==state.activeHead) throw Error('STALE_AUTHORITY');
  const eventHash=await digest(provider,'event',item.event);
  if (eventHash!==confirmedEventHash || item.rotation?.grant?.version!==2) throw Error('INVALID_REVOCATION');
  const body={root:pin,householdId:scope.id,from:parent.head,to:eventHash,deviceId:recipientDevice,index:state.selections.length};
  const publisherSelection=p.selection;
  if (fresh&&publisherSelection?.index!==body.index || !exact(publisherSelection,'from,to,deviceId,index,signature') ||
      publisherSelection.from!==parent.head||publisherSelection.to!==eventHash||
      publisherSelection.deviceId!==item.event.authorDeviceId||
      !await verifySignature(provider,parent.devices.find(d=>d.deviceId===publisherSelection.deviceId)?.signingKeyRef,'select-head',
        {...body,deviceId:publisherSelection.deviceId,index:publisherSelection.index},publisherSelection.signature)) throw Error('INVALID_SELECTION');
  const selection=savedSelection??(publisherSelection.index===body.index?publisherSelection:{from:body.from,to:body.to,deviceId:recipientDevice,index:body.index,
    signature:hex(sodium.crypto_sign_detached(domain('select-head',body),keys.signingSecret))});
  const next={...state,events:[...state.events,item],selections:[...state.selections,selection],activeHead:eventHash};
  await verifyAuthority(next,pin,provider);
  const {context,guardId}=await verifyRotationPayload({sodium,provider,LoroDoc,parent,item,recipientDevice,
    documentId:p.document.documentId,generation:p.document.generation,manifest:p.manifest,seed,snapshot:p.document.bytes,packet:p.packet});
  if (confirmedGrantHash!==context.grantHash || p.grantHash!==context.grantHash || hex(keys.signingSecret.subarray(32))!==context.recipientSigningKey ||
      hex(sodium.crypto_scalarmult_base(keys.wrappingSecret))!==context.recipientWrappingKey) throw Error('INVALID_RECIPIENT');
  return {kind:recovery?'recovery':'revocation',fresh,expectedAuthority:record,guardId,context,packet:p.packet,snapshot:p.document.bytes,
    nextAuthority:{scope,revision:record.revision+1,acceptedParent:eventHash,authorizationSnapshot:await digest(provider,'authority-state',next),authorityState:encode(next)}};
}
