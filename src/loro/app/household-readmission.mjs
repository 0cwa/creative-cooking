// Public exchanges can request or authorize access. Only an authenticated,
// recipient-specific rotation file can install a household key.
import {readAuthority,verifyAuthority} from '../authority/chain.mjs';
import {admissionThreshold,domain} from '../authority/validator.mjs';
import {recoverySenderKeyBytes,verifyRecoveryProof} from '../compromise/recovery-proof.mjs';
import {digest,exact,hex,same,verifyRevocation,verifySignature} from '../compromise/revocation.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {answerRecoveryChallenge,continuityBindingBytes,continuityPublicKey,persistRecoveryChallenge,
 recoveryBindingOnAncestry,recoveryClaimBytes,recoveryClaimHash,recoveryConfirmationBytes,verifyRecoveryClaim,verifyRecoveryPossession} from '../recovery/readmission.mjs';
import {recoveryHash} from '../recovery/enrollment.mjs';
import {inspectPersonal} from '../recovery/recovery.mjs';
import {openRecoveryArchive} from './recovery-archive.mjs';
import {verifyHouseholdParentRecord} from './household-parent.mjs';

const slot=(...parts)=>JSON.stringify(['recovery-install',...parts]);
const challengeDomain='household-readmission-challenge';
const sponsorDomain='household-readmission-sponsor-parent';
const sponsorRequestDomain='household-readmission-request-sponsor';
const claimProof=({claim,continuitySignature,deviceSignature})=>({claim,continuitySignature,deviceSignature});
const eligible=(parent,id)=>parent.devices.find(d=>d.active&&d.deviceId===id&&parent.runtime.acceptedRecipients.includes(id));
const requireExplicit=explicit=>{if(explicit!==true)throw Error('CONFIRMATION_REQUIRED');};
const needsRecovery=(parent,claim)=>{
 if(!parent.roster.includes(claim.owner))throw Error('INELIGIBLE_RECOVERY');
 const voters=new Set(parent.devices.filter(d=>d.adultId!==claim.owner&&eligible(parent,d.deviceId)).map(d=>d.adultId));
 if(voters.size<admissionThreshold(parent.policy,parent.roster.length))throw Error('NO_AUTHORIZED_QUORUM');
 if(parent.devices.some(d=>d.active&&d.adultId===claim.owner))throw Error('INELIGIBLE_RECOVERY');
};

export function householdReadmission({
 storage,scope,pin,provider,sodium,run,runtime,rotation,withSecrets,deviceId,signingKey,wrappingPublicKey,
 personalScopeId,personalPin,recovery,recoveryImport,pins,transfer
}){
 const context={sodium,storage,scope,pin,provider}, registry=storage.continuity;
 const registryInput={...context};
 const sign=async (body)=>hex(await provider.sign(signingKey,body));
 const local=async()=>{
  const current=await readAuthority(storage,scope,pin,provider), {nodes}=await verifyAuthority(current.state,pin,provider);
  const parent=nodes.get(current.activeHead), device=eligible(parent,deviceId);
  if(!device)throw Error('NO_AUTHORIZED_DEVICE');
  return {current,nodes,parent,device};
 };
 const registration=(owner)=>registry.current({...registryInput,owner});
 const claims=(claim,registered)=>({...context,...claim,continuityRegistry:registry,
  continuityBinding:registered?.binding,continuityBindingSignature:registered?.bindingSignature});
 async function checkClaim(request){
  if(!exact(request,'claim,continuitySignature,deviceSignature'))throw Error('INVALID_CLAIM');
  const registered=await registration(request.claim?.owner);
  if(!registered)throw Error('CONTINUITY_NOT_REGISTERED');
  const result=await verifyRecoveryClaim(claims(request,registered));
  needsRecovery(result.parent,request.claim);
  return result;
 }
 async function checkChallenge(parent,request,message){
  if(!exact(message,'challenge,sponsorDevice,signature'))throw Error('INVALID_PROOF');
  const {challenge,sponsorDevice,signature}=message, sponsor=eligible(parent,sponsorDevice);
  if(!sponsor||request.sponsor?.deviceId!==sponsorDevice||challenge?.claimHash!==recoveryClaimHash(sodium,request.claim)||
     !await verifySignature(provider,sponsor.signingKeyRef,challengeDomain,{challenge,sponsorDevice},signature))throw Error('INVALID_PROOF');
 }
 const sponsorBody=(sponsor,confirmed)=>({deviceId:sponsor.deviceId,snapshot:sponsor.snapshot,
  scope:confirmed.scope,rootPin:confirmed.pin,head:confirmed.head});
 async function checkSponsor(sponsor,confirmed,parent,snapshot){
  const current=eligible(parent,sponsor?.deviceId);
  if(!exact(sponsor,'deviceId,snapshot,signature')||!current||sponsor.snapshot!==snapshot||
     !await verifySignature(provider,current.signingKeyRef,sponsorDomain,sponsorBody(sponsor,confirmed),sponsor.signature))throw Error('INVALID_SPONSOR');
 }
 async function checkSponsorRequest(request,checked){
  const {sponsor,sponsorSignature}=request;
  if(sponsor?.deviceId!==deviceId||
     !await verifySignature(provider,request.claim.signingKey,sponsorRequestDomain,{claimHash:checked.claimHash,sponsor},sponsorSignature))throw Error('INVALID_SPONSOR');
  await checkSponsor(request.sponsor,{scope,pin,head:checked.parent.head},checked.parent,
   await digest(provider,'authority-state',checked.authority.state));
 }
 async function freshParent(householdId){
  const confirmed=(await pins.list()).find(p=>p.scope.id===householdId);
  if(!confirmed)throw Error('CONFIRMATION_REQUIRED');
  const verified=await verifyPublicParent(storage,confirmed.scope,confirmed.pin,provider);
  if(verified.state.activeHead!==confirmed.head)throw Error('STALE_AUTHORITY');
  return {...verified,confirmed,parent:verified.nodes.get(confirmed.head)};
 }
 const requestSlot=(id)=>slot('readmission-request',id,deviceId);
 async function ownRequest(householdId){
  const request=await run(false,tx=>tx.get(requestSlot(householdId)));
  if(!request||request.claim.deviceId!==deviceId||request.claim.signingKey!==signingKey||
     request.claim.wrappingKey!==wrappingPublicKey)throw Error('MISSING_REQUEST');
  return request;
 }
 async function review(proposal,required=false){
  const proof=proposal?.recoveryProof, event=proposal?.item?.event;
  if(event?.kind!=='recoverDevice'||!proof)throw Error('INVALID_RECOVERY_PROOF');
  const {parent,nodes,registered,claimHash}=await checkClaim({
   claim:proof.claim,continuitySignature:proof.continuitySignature,deviceSignature:proof.deviceSignature
  });
  verifyRecoveryPossession(sodium,proof.claim,proof.challenge,proof.possession);
  if(claimHash!==event.subject.claimHash||registered.bindingHash!==event.subject.bindingHash||
     !same(proof.binding,registered.binding)||proof.bindingSignature!==registered.bindingSignature||
     !same(proof.confirmations.map(({adultId,deviceId})=>({adultId,deviceId})),
      proposal.item.approvals.map(({adultId,deviceId})=>({adultId,deviceId}))))throw Error('INVALID_RECOVERY_PROOF');
  await verifyRecoveryProof({sodium,parent,nodes,event,proof,provider,requireQuorum:required});
  return rotation.review(proposal,false,required);
 }
 async function reviewRecipient({proposal,fresh}){
   const event=proposal?.item?.event;
   if(event?.kind!=='recoverDevice')throw Error('INVALID_RECOVERY_PROOF');
   if(!fresh)return {...await review(proposal,true),scope,claimHash:event.subject.claimHash};
   const request=await ownRequest(event.householdId);
   const confirmed=(await pins.list()).find(p=>p.scope.id===event.householdId);
   if(!confirmed||!same(request.claim,proposal.recoveryProof.claim)||event.parentHead!==confirmed.head)throw Error('INVALID_RECOVERY_PROOF');
   // Exact retries may use the durable receipt's original independently pinned parent.
   const {parent,nodes,state,record,installed}=await transfer.readRecoveryParent(confirmed);
   if(request.sponsor){
    if(request.sponsor.deviceId!==event.authorDeviceId)throw Error('INVALID_SPONSOR');
    await checkSponsor(request.sponsor,confirmed,parent,record.authorizationSnapshot);
   }else if(!installed)throw Error('MISSING_SPONSOR_PARENT');
   const checked=await verifyRevocation({provider,parent,...proposal});
   await verifyRecoveryProof({sodium,provider,parent,nodes,event,proof:proposal.recoveryProof});
   if(!await recoveryBindingOnAncestry(provider,state.events,parent.head,proposal.recoveryProof.binding.checkpoint))throw Error('INVALID_RECOVERY_PROOF');
   return {...checked,scope:confirmed.scope,claimHash:event.subject.claimHash,parentSnapshot:record.authorizationSnapshot};
  }
 const registrationState=(owner,bindingHash)=>slot('registered-catalog',scope.id,owner,bindingHash);
 const catalogFor=(owner,bindingHash)=>bindingHash?run(false,tx=>tx.get(registrationState(owner,bindingHash))):null;
 function rememberCatalog(owner,bindingHash,catalogHash){
  return run(true,async tx=>{
   const key=registrationState(owner,bindingHash), prior=await tx.get(key);
   if(prior!==undefined&&prior!==catalogHash)throw Error('CONFLICT');
   if(prior===undefined)await tx.put(key,catalogHash);
  });
 }
 return {
  async exportSponsorParent(){
   const {current}=await local();
   const bundle={version:1,scope,rootPin:pin,selectedHead:current.activeHead,state:current.state};
   const sponsor={deviceId,snapshot:await digest(provider,'authority-state',current.state)};
   return {bundle,sponsor:{...sponsor,signature:await sign(domain(sponsorDomain,sponsorBody(sponsor,{scope,pin,head:current.activeHead})))}};
  },
  async createArchive(){
   const {device}=await local();
   const current=await registration(device.adultId);
   const previous=await catalogFor(device.adultId,current?.bindingHash);
   if(current&&!previous)throw Error('PREVIOUS_CATALOG_REQUIRED');
   return recovery.create({generation:current?current.binding.generation+1:0,previousCatalogHash:previous});
  },
  async registerArchive({archive,code,explicit}){
   requireExplicit(explicit);
   const {body}=await openRecoveryArchive(sodium,archive,code), {parent,device}=await local();
   if(body.scopeId!==personalScopeId||body.pin!==personalPin||body.owner!==device.adultId)throw Error('WRONG_RECOVERY_OWNER');
   const catalogHash=recoveryHash(sodium,body.catalog), generation=body.catalog.generation;
   const continuityKey=continuityPublicKey(sodium,inspectPersonal(sodium,{code,package:body.package},{owner:body.owner,generation,catalogHash}));
   const prior=await registration(body.owner), previous=await catalogFor(body.owner,prior?.bindingHash);
   if(prior&&generation===prior.binding.generation&&prior.binding.continuityKey===continuityKey){
    await rememberCatalog(body.owner,prior.bindingHash,catalogHash);
    return {binding:prior.binding,bindingSignature:prior.bindingSignature};
   }
   if(prior?(generation!==prior.binding.generation+1||!previous||body.catalog.previousCatalogHash!==previous):
    generation!==0||body.catalog.previousCatalogHash!==null)throw Error('WRONG_RECOVERY_GENERATION');
   const binding={version:1,householdId:scope.id,owner:body.owner,checkpoint:parent.head,signerDevice:deviceId,generation,continuityKey};
   const bindingSignature=await sign(continuityBindingBytes(binding));
   const expectedAuthority=await runtime.authorize();
   const {bindingHash}=await registry.register({...registryInput,expectedAuthority,binding,bindingSignature});
   await rememberCatalog(body.owner,bindingHash,catalogHash);
   return {binding,bindingSignature};
  },
  async retainRegistration({message,explicit}){
   requireExplicit(explicit);
   if(!exact(message,'binding,bindingSignature'))throw Error('INVALID_BINDING');
   const expectedAuthority=await runtime.authorize();
   return registry.register({...registryInput,expectedAuthority,...message});
  },
  async installed(){
   const installed=[];
   for(const confirmed of await pins.list()){
    const request=await run(false,tx=>tx.get(requestSlot(confirmed.scope.id)));
    if(!request)continue;
    const result=await transfer.installedRecovery(confirmed);
    if(result&&result.adultId===request.claim.owner)installed.push(result);
   }
   return installed;
  },
  async request({householdId,sponsorParent,explicit}){
   requireExplicit(explicit);
   sponsorParent=structuredClone(sponsorParent);
   const {parent,confirmed}=await freshParent(householdId);
   return recoveryImport.useContinuity(async (saved,credential)=>{
    const continuityKey=continuityPublicKey(sodium,credential);
    const claim={version:1,householdId,owner:saved.owner,checkpoint:parent.head,policyHash:parent.policyHash,deviceId,
     signingKey,wrappingKey:wrappingPublicKey,continuityKey,recoveryGeneration:saved.generation,nonce:hex(sodium.randombytes_buf(32))};
    needsRecovery(parent,claim);
    if(parent.devices.some(d=>d.deviceId===deviceId||d.signingKeyRef===signingKey))throw Error('INVALID_FRESH_DEVICE');
    if(!exact(sponsorParent,'bundle,sponsor'))throw Error('MISSING_SPONSOR_PARENT');
    const {bundle,sponsor}=sponsorParent;
    if(!same(bundle?.scope,confirmed.scope)||bundle.rootPin!==confirmed.pin||bundle.selectedHead!==confirmed.head)throw Error('INVALID_SPONSOR');
    const record=await verifyHouseholdParentRecord({provider,bundle,confirmedRootPin:confirmed.pin,confirmedSelectedHead:confirmed.head,explicit});
    await checkSponsor(sponsor,confirmed,parent,record.authorizationSnapshot);
    const payload=recoveryClaimBytes(claim), seed=sodium.from_hex(credential),pair=sodium.crypto_sign_seed_keypair(seed);
    try{
     const sponsorSignature=await sign(domain(sponsorRequestDomain,{claimHash:recoveryClaimHash(sodium,claim),sponsor}));
     const request={claim,continuitySignature:hex(sodium.crypto_sign_detached(payload,pair.privateKey)),deviceSignature:await sign(payload),sponsor,sponsorSignature};
     const saved=await storage.commitHouseholdReadmissionRequest(record,request);
     if(!saved.ok)throw Error(saved.error);
     return saved.value;
    }finally{seed.fill(0);pair.privateKey.fill(0);}
   });
  },
  async issue({request,explicit}){
   requireExplicit(explicit);
   if(!exact(request,'claim,continuitySignature,deviceSignature,sponsor,sponsorSignature'))throw Error('INVALID_CLAIM');
   const checked=await checkClaim(claimProof(request)), {parent}=checked;
   await checkSponsorRequest(request,checked);
   if(!eligible(parent,deviceId))throw Error('NO_AUTHORIZED_DEVICE');
   const expected=await runtime.authorize();
   if(expected.record.acceptedParent!==parent.head)throw Error('STALE_AUTHORITY');
   const challenge=await persistRecoveryChallenge(sodium,run,request.claim);
   const body={challenge,sponsorDevice:deviceId};
   return {...body,signature:await sign(domain(challengeDomain,body))};
  },
  async answer({householdId,message,explicit}){
   requireExplicit(explicit);
   const request=await ownRequest(householdId),{parent,confirmed,record}=await freshParent(householdId);
   if(request.claim.checkpoint!==parent.head)throw Error('STALE_AUTHORITY');
   await checkSponsor(request.sponsor,confirmed,parent,record.authorizationSnapshot);
   await checkChallenge(parent,request,message);
   return withSecrets(({signingSecret,wrappingSecret})=>{
    const possession=answerRecoveryChallenge(sodium,request.claim,message.challenge.sealed,sodium.from_hex(wrappingPublicKey),wrappingSecret,signingSecret);
    verifyRecoveryPossession(sodium,request.claim,message.challenge,possession);
    return {request,message,possession};
   });
  },
  async prepare({response,bindings,explicit}){
   requireExplicit(explicit);
   const {request,message,possession}=response??{};
   if(!exact(request,'claim,continuitySignature,deviceSignature,sponsor,sponsorSignature'))throw Error('INVALID_CLAIM');
   const checked=await checkClaim(claimProof(request));
   await checkSponsorRequest(request,checked);
   await checkChallenge(checked.parent,request,message);
   if(message.sponsorDevice!==deviceId)throw Error('INVALID_SPONSOR');
   const challenge=await run(false,tx=>tx.get(JSON.stringify(['recovery-readmission-challenge',scope.id,checked.claimHash])));
   if(!same(challenge,message.challenge))throw Error('MISSING_CHALLENGE');
   verifyRecoveryPossession(sodium,request.claim,challenge,possession);
   const {proposal}=await rotation.prepare({recovery:{claim:request.claim,claimHash:checked.claimHash,bindingHash:checked.registered.bindingHash},bindings,explicit});
   const recoveryProof={...claimProof(request),binding:checked.registered.binding,bindingSignature:checked.registered.bindingSignature,
    challenge,possession,confirmations:[],senderSigningKey:signingKey,senderWrappingKey:wrappingPublicKey,
    senderKeySignature:await sign(recoverySenderKeyBytes(proposal.grant.eventHash,signingKey,wrappingPublicKey))};
   const next={...proposal,recoveryProof};
   return {proposal:next,...await review(next)};
  },
  review,
  async approve({proposal,confirmed,explicit}){
   requireExplicit(explicit);
   const checked=await review(proposal), {device}=await local();
   if(!checked.canApprove||checked.confirmation!==confirmed)throw Error('APPROVAL_UNAVAILABLE');
   const {recoveryProof:proof}=proposal,{claimHash,tokenCommitment}=proof.challenge;
   proof.confirmations.push({adultId:device.adultId,deviceId,
    signature:await sign(recoveryConfirmationBytes(claimHash,tokenCommitment,device.adultId,deviceId))});
   const approved=await rotation.approve({proposal,confirmed,explicit});
   return {proposal:approved.proposal,...await review(approved.proposal)};
  },
  async publish({proposal,confirmed,explicit}){
   requireExplicit(explicit);
   return rotation.publish({proposal,confirmed,explicit,recoveryRun:run,continuityRegistry:registry});
  },
  async status(){
   const {current,parent}=await local();
   const entry=current.state.events.find(e=>e.event.kind==='recoverDevice'&&e.rotation?.grant?.version===2&&e.rotation.grant.eventHash===parent.head);
   let published=null;
   if(entry?.rotation.localDeviceId===deviceId){
    const {event,approvals,authorSignature,rotation:{grant,manifest,recipientBindings,recoveryProof,operationId}}=entry;
    published={operationId,recipients:parent.runtime.acceptedRecipients.filter(id=>id!==deviceId),
     proposal:{item:{event,approvals,authorSignature},grant,manifest,recipientBindings,recoveryProof}};
   }
   return {head:parent.head,reopen:parent.head!==runtime.scope.branchHead?parent.head:null,published};
  },
  seal(input){return rotation.seal({...input,kind:'recovery'});},
  binding:rotation.binding,
  reviewRecipient,
  async install({proposal,bytes,fresh,explicit}){
   requireExplicit(explicit);
   // The file verifier replays the full signed decision and checks these digests.
   // Existing-device retries can use their durable receipt after moving heads.
   const event=proposal?.item?.event;
   if(event?.kind!=='recoverDevice')throw Error('INVALID_RECOVERY_PROOF');
   const checked=fresh?await reviewRecipient({proposal,fresh}):{
    scope,claimHash:event.subject.claimHash,eventHash:await digest(provider,'event',event),
    grantHash:await digest(provider,'rotation-distribution-grant',Object.fromEntries(Object.entries(proposal.grant).filter(([k])=>k!=='signatures')))
   };
   const decisionHash=await digest(provider,'recovery-file-decision',proposal);
   return transfer.installRecovery({...checked,bytes,fresh,decisionHash});
  }
 };
}
