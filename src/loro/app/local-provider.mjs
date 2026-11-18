// Cryptographic operations use the wrapped local catalog; secret bytes exist only
// inside LocalKeys.use and are wiped by that API after each operation.
export function localProvider(sodium,keys,{signing,content}) {
 const fromHex=s=>{if(typeof s!=='string'||!/^[0-9a-f]{64}$/.test(s))throw Error('INVALID_KEY');return sodium.from_hex(s)};
 const signRef=signing.publicKey;
 const withData=(ref,fn,header)=>{if(typeof content==='function')return content(ref,fn,header);const entry=content[ref];if(!entry)throw Error('MISSING_KEY');return keys.use(entry.operationId,entry.identity,fn)};
 return {
  hash:async bytes=>sodium.crypto_generichash(32,bytes),
  verify:async (ref,bytes,signature)=>sodium.crypto_sign_verify_detached(signature,bytes,fromHex(ref)),
  sign:async (ref,bytes)=>{if(ref!==signRef)throw Error('MISSING_KEY');return keys.use(signing.operationId,signing.identity,secret=>sodium.crypto_sign_detached(bytes,secret));},
  encrypt:async (ref,value,aad,header)=>withData(ref,secret=>{const nonce=sodium.randombytes_buf(24);const ciphertext=sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(value,aad,null,nonce,secret);return new Uint8Array([...nonce,...ciphertext]);},header),
  decrypt:async (header,value,aad)=>withData(header.epochId,secret=>{if(value.length<40)throw Error('INVALID_PROOF');return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,value.slice(24),aad,value.slice(0,24),secret);},header),
  wrap:async()=>{throw Error('PAIRING_REQUIRED')},unwrap:async()=>{throw Error('PAIRING_REQUIRED')}
 };
}
