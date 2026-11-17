import {sodium} from './native-sodium';
const fromHex = s => Uint8Array.from(s.match(/../g)||[],x=>parseInt(x,16));
const hex = b => Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const utf8 = s => new TextEncoder().encode(s);
export function cryptoVectors() {
 const seed=fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
 const pair=sodium.crypto_sign_seed_keypair(seed);
 if(hex(pair.publicKey)!=='d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a') throw Error('RFC8032 public key');
 const signature=sodium.crypto_sign_detached(new Uint8Array(),pair.privateKey);
 if(hex(signature)!=='e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155'+'5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b') throw Error('RFC8032 signature');
 const nonce=new Uint8Array(24),key=new Uint8Array(32),aad=utf8('K1 AAD');
 const cipher=sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(utf8('K1 vector'),aad,null,nonce,key);
 if(hex(cipher)!=='33afb6ff8043f910ab0d80ae8bb89ad07e7d7ec0d42a50c374') throw Error('XChaCha vector');
 const unicode=utf8('scope=räksoppa');const c=sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(utf8('payload'),unicode,null,nonce,key);
 if(hex(sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,c,unicode,nonce,key))!==hex(utf8('payload')))throw Error('UTF-8 AAD');
 let rejected=false;try{sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(utf8('x'),new Uint8Array([255]),null,nonce,key)}catch{rejected=true}if(!rejected)throw Error('invalid UTF-8 accepted');
 return ['RFC8032 Ed25519', 'XChaCha fixed vector', 'UTF-8 associated data', 'invalid UTF-8 rejected'];
}
