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
 crypto_aead_xchacha20poly1305_ietf_encrypt:(message,aad,secret,nonce,key)=>native.crypto_aead_xchacha20poly1305_ietf_encrypt(message,utf8(aad),secret,nonce,key),
 crypto_aead_xchacha20poly1305_ietf_decrypt:(secret,cipher,aad,nonce,key)=>native.crypto_aead_xchacha20poly1305_ietf_decrypt(secret,cipher,utf8(aad),nonce,key),
};
export default sodium;
