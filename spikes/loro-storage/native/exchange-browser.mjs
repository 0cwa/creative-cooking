import sodium from 'libsodium-wrappers';
import {LoroDoc} from 'loro-crdt/base64';
import {generate,verify} from './exchange.mjs';
window.exchange = {
 generate:()=>{const d=new LoroDoc();d.setPeerId('42');d.getMap('exchange').set('title','browser');return generate(sodium,'browser',d.export({mode:'update'}));},
 verify:async packet=>{const result=await verify(sodium,packet);const d=new LoroDoc();d.import(Uint8Array.from(result.update));if(d.getMap('exchange').get('title')!==packet.origin)throw Error('Loro update mismatch');return {content:result.content,wrapped:result.wrapped,tamperRejected:result.tamperRejected,domainRejected:result.domainRejected,versionRejected:result.versionRejected,keyEnvelopeRejected:result.keyEnvelopeRejected,loro:true};},
};
