// Candidate bridge for the codec's UTF-8 JSON associated data only.
import * as native from 'react-native-libsodium';
const utf8 = input => {
 if (!(input instanceof Uint8Array)) throw Error('AAD must be bytes');
 const string = new TextDecoder('utf-8',{fatal:true}).decode(input);
 const roundtrip = new TextEncoder().encode(string);
 if (roundtrip.length !== input.length || roundtrip.some((b,i)=>b!==input[i])) throw Error('AAD is not UTF-8');
 return string;
};
export const sodium = {
 ...native,
 from_hex:value=>{if(typeof value!=='string'||value.length%2||!/^[0-9a-fA-F]*$/.test(value))throw Error('INVALID_HEX');return Uint8Array.from(value.match(/../g)??[],x=>parseInt(x,16));},
 crypto_scalarmult_base:scalar=>{if(!(scalar instanceof Uint8Array)||scalar.length!==32||typeof globalThis.jsi_cc_crypto_scalarmult_base!=='function')throw Error('NATIVE_SCALARMULT_UNAVAILABLE');const copy=scalar.slice();try{return new Uint8Array(globalThis.jsi_cc_crypto_scalarmult_base(copy.buffer));}finally{copy.fill(0)}},
 crypto_aead_xchacha20poly1305_ietf_encrypt:(message,aad,secret,nonce,key)=>native.crypto_aead_xchacha20poly1305_ietf_encrypt(message,utf8(aad),secret,nonce,key),
 crypto_aead_xchacha20poly1305_ietf_decrypt:(secret,cipher,aad,nonce,key)=>native.crypto_aead_xchacha20poly1305_ietf_decrypt(secret,cipher,utf8(aad),nonce,key),
};
export default sodium;
