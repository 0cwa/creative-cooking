import {restorePersonal,authenticatePersonal} from './recovery.mjs';
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const e=new TextEncoder();
// The local record reserves a fresh device identifier before key creation and binds retries
// to the exact package. It provides no household authority or admission evidence.
export async function restoreWithFreshDevice({sodium,run,keys,providerForDevice,owner,scopeId,operationId,package:pkg,code,generation}){
 pkg=structuredClone(pkg);
 if(![owner,scopeId].every(x=>typeof x==='string'&&x.length>0&&e.encode(x).length<=256)||!(typeof operationId==='string'&&operationId.length>0&&e.encode(operationId).length<=128)||!Number.isSafeInteger(generation)||generation<0)throw Error('INVALID_INPUT');
 if(typeof run!=='function'||typeof keys?.generate!=='function'||typeof providerForDevice!=='function')throw Error('INVALID_INPUT');
 authenticatePersonal(sodium,pkg,code,{owner,generation});
 const input=hex(sodium.crypto_generichash(32,e.encode(JSON.stringify([owner,scopeId,generation,pkg]))));
 const recordKey=JSON.stringify(['recovery-device',scopeId,operationId]);let candidate=sodium.randombytes_buf(16);if(!(candidate instanceof Uint8Array)||candidate.length!==16)throw Error('RNG_UNAVAILABLE');candidate=hex(candidate);
 const deviceId=await run(true,async tx=>{const prior=await tx.get(recordKey);if(prior!==undefined){if(!prior||prior.version!==1||prior.input!==input||typeof prior.deviceId!=='string'||!/^[0-9a-f]{32}$/.test(prior.deviceId))throw Error('CONFLICT');return prior.deviceId}await tx.put(recordKey,{version:1,input,deviceId:candidate});return candidate});
 const identity=purpose=>({version:1,scope:{kind:'personal',id:scopeId},deviceId,purpose,epochId:'device-v1'});
 const signing=await keys.generate(`recovery-sign:${deviceId}`,identity('device-signing'));
 const wrapping=await keys.generate(`recovery-wrap:${deviceId}`,identity('device-wrapping'));
 const result=await restorePersonal(sodium,pkg,code,{owner,generation},providerForDevice(deviceId));
 return {...result,device:{deviceId,signingPublicKey:signing.publicKey,wrappingPublicKey:wrapping.publicKey},householdAuthority:'readmission-required'};
}
