// Candidate ceremony only. This never grants admission or releases keys.
import {readAuthority,verifyAuthority,resolveRuntimeAuthority} from '../authority/chain.mjs';
const enc=new TextEncoder(),hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const id=x=>typeof x==='string'&&x.length>0&&enc.encode(x).length<=256;
const exact=(x,k)=>x&&typeof x==='object'&&!Array.isArray(x)&&!(x instanceof Uint8Array)&&Object.keys(x).length===k.length&&k.every(v=>Object.hasOwn(x,v));
const bytes=(x,n)=>x instanceof Uint8Array&&x.length===n;
const equal=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const roleNames=['initiator','responder'];
const domain=(purpose,value)=>enc.encode(JSON.stringify(['creative-cooking/pairing-candidate/v2',purpose,value]));
const digest=(s,b)=>s.crypto_generichash(32,b);
/** Exact canonical transcript, including both key bundles, roles, guard and signaling. */
export function ceremonyBytes(t,g){
 if(!exact(t,['version','sessionId','action','scope','purpose','acceptedParent','authorizationSnapshot','initiator','responder','signaling'])||t.version!==1||!id(t.sessionId)||!['pairOwnDevice','inviteAdult','recoverDevice'].includes(t.action)||!exact(t.scope,['kind','id'])||!['personal','household'].includes(t.scope.kind)||!id(t.scope.id)||!id(t.purpose)||!id(t.acceptedParent)||!id(t.authorizationSnapshot)||!exact(g,['version','guardId','scope','direction','purpose'])||g.version!==1||!id(g.guardId)||!exact(g.scope,['kind','id'])||g.scope.kind!==t.scope.kind||g.scope.id!==t.scope.id||g.purpose!==t.purpose||!['initiator-to-responder','responder-to-initiator'].includes(g.direction))throw Error('MALFORMED');
 const roles=roleNames.map(name=>{const r=t[name];if(!exact(r,['role','deviceId','signingPublicKey','wrappingPublicKey','nonce'])||r.role!==name||!id(r.deviceId)||!bytes(r.signingPublicKey,32)||!bytes(r.wrappingPublicKey,32)||!bytes(r.nonce,32))throw Error('MALFORMED');return [r.role,r.deviceId,hex(r.signingPublicKey),hex(r.wrappingPublicKey),hex(r.nonce)]});
 if(t.initiator.deviceId===t.responder.deviceId||equal(t.initiator.nonce,t.responder.nonce)||!Array.isArray(t.signaling)||!t.signaling.length||t.signaling.length>64||!t.signaling.every(x=>x instanceof Uint8Array&&x.length>0&&x.length<=131072)||t.signaling.reduce((n,x)=>n+x.length,0)>2097152)throw Error('MALFORMED');
 return domain('transcript',[t.version,t.sessionId,t.action,[t.scope.kind,t.scope.id],t.purpose,t.acceptedParent,t.authorizationSnapshot,...roles,t.signaling.map(hex),[g.version,g.guardId,[g.scope.kind,g.scope.id],g.direction,g.purpose]]);
}
const confirmation=(role,transcript)=>domain('role-confirmation',[role,hex(transcript)]);
const responseBytes=(role,transcript,ciphertext,token)=>domain('possession-response',[role,hex(transcript),hex(ciphertext),hex(token)]);
export function challengeBytes(sodium,role,transcript,token){
 if(!roleNames.includes(role)||!(transcript instanceof Uint8Array)||!bytes(token,32))throw Error('MALFORMED');
 return domain('wrapping-challenge',[role,hex(digest(sodium,transcript)),hex(token)]);
}
export function decodeChallengeToken(sodium,role,transcript,plaintext){
 let token;
 try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext)),h=value?.[2]?.[2];if(typeof h!=='string'||!/^[0-9a-f]{64}$/.test(h))throw Error();token=Uint8Array.from(h.match(/../g),x=>parseInt(x,16));if(!equal(plaintext,challengeBytes(sodium,role,transcript,token)))throw Error();return token}catch{token?.fill(0);throw Error('INVALID_PROOF')}
}
export function signConfirmation(sodium,role,transcript,secret){if(!roleNames.includes(role))throw Error('MALFORMED');return sodium.crypto_sign_detached(confirmation(role,transcript),secret)}
/** Only the intended wrapping private key can open the random challenge. */
export function answerChallenge(sodium,role,transcript,ciphertext,wrappingPublic,wrappingSecret,signingSecret){if(!roleNames.includes(role)||!bytes(wrappingPublic,32)||!(ciphertext instanceof Uint8Array))throw Error('MALFORMED');let token,plaintext;try{plaintext=sodium.crypto_box_seal_open(ciphertext,wrappingPublic,wrappingSecret);token=decodeChallengeToken(sodium,role,transcript,plaintext);return {token:new Uint8Array(token),signature:sodium.crypto_sign_detached(responseBytes(role,transcript,ciphertext,token),signingSecret)}}finally{token?.fill(0);plaintext?.fill(0)}}
/** trustedLocal is supplied by the local UI/key pin store, never decoded from peer messages.
 * Each role's full key record must have been independently confirmed for these exact bytes. */
export function beginCeremony(sodium,t,g,trustedLocal){
 t=structuredClone(t);g=structuredClone(g);const transcript=ceremonyBytes(t,g),th=digest(sodium,transcript);
 if(!exact(trustedLocal,['confirmedTranscriptHash','pins'])||!bytes(trustedLocal.confirmedTranscriptHash,32)||!equal(trustedLocal.confirmedTranscriptHash,th)||!exact(trustedLocal.pins,roleNames))throw Error('OOB_REQUIRED');
 for(const role of roleNames){const p=trustedLocal.pins[role],r=t[role];if(!exact(p,['deviceId','signingPublicKey','wrappingPublicKey'])||p.deviceId!==r.deviceId||!equal(p.signingPublicKey,r.signingPublicKey)||!equal(p.wrappingPublicKey,r.wrappingPublicKey))throw Error('OOB_REQUIRED')}
 const challenges={},secrets={};for(const role of roleNames){secrets[role]=sodium.randombytes_buf(32);const plaintext=challengeBytes(sodium,role,transcript,secrets[role]);try{challenges[role]=sodium.crypto_box_seal(plaintext,t[role].wrappingPublicKey)}finally{plaintext.fill(0)}}let used=false;
 return {transcript:new Uint8Array(transcript),challenges:structuredClone(challenges),async verify({confirmations,responses},authority){
  if(used)throw Error('REPLAY');used=true;
  try{if(!exact(confirmations,roleNames)||!exact(responses,roleNames))throw Error('INVALID_PROOF');for(const role of roleNames){const sig=confirmations[role],r=responses[role],pub=t[role].signingPublicKey;if(!bytes(sig,64)||!sodium.crypto_sign_verify_detached(sig,confirmation(role,transcript),pub)||!exact(r,['token','signature'])||!bytes(r.token,32)||!bytes(r.signature,64)||!equal(r.token,secrets[role])||!sodium.crypto_sign_verify_detached(r.signature,responseBytes(role,transcript,challenges[role],r.token),pub))throw Error('INVALID_PROOF')}
   // Current sponsor membership is not an admission or key-release decision.
   if(!authority||t.scope.kind!=='household'||!roleNames.includes(authority.sponsorRole))throw Error('UNAVAILABLE');const sponsor=t[authority.sponsorRole];const resolved=await resolveRuntimeAuthority(authority.storage,t.scope,authority.rootPin,authority.provider,sponsor.deviceId);if(resolved.scope.branchHead!==t.acceptedParent||resolved.scope.authorizationSnapshot!==t.authorizationSnapshot)throw Error('UNAUTHORIZED');const view=await readAuthority(authority.storage,t.scope,authority.rootPin,authority.provider);if(view.revision!==resolved.expectedAuthority.record.revision||view.activeHead!==resolved.scope.branchHead)throw Error('CONFLICT');const verified=await verifyAuthority(view.state,authority.rootPin,authority.provider),node=verified.nodes.get(view.activeHead),device=node.devices.find(x=>x.active&&x.deviceId===sponsor.deviceId);if(!device||!await authority.provider.verify(device.signingKeyRef,confirmation(authority.sponsorRole,transcript),confirmations[authority.sponsorRole]))throw Error('UNAUTHORIZED');
   return {transcript:structuredClone(t),guard:structuredClone(g),transcriptHash:new Uint8Array(th),authority:resolved.expectedAuthority};
  }finally{for(const role of roleNames)secrets[role].fill(0)}
 }};
}
// No release or admission is asserted by a cryptographically valid ceremony.
export function candidatePairing(){return {async releaseKeys(){throw Error('RELEASE_UNAVAILABLE')}}}
