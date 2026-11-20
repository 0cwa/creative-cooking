import {digest,CryptoDigestAlgorithm} from 'expo-crypto';
/** SHA-256 provider for the shared frame codec; does not mutate global crypto. */
export async function sha256(bytes:Uint8Array):Promise<string> {
 if(!(bytes instanceof Uint8Array))throw Error('MALFORMED');
 const value=new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256,new Uint8Array(bytes)));
 return Array.from(value,x=>x.toString(16).padStart(2,'0')).join('');
}
