// Candidate web-shaped adapter; production binding selection remains pending.
import {LoroDoc as NativeDoc, Frontiers, VersionVector, decodeImportBlobMeta as decodeNative} from 'loro-react-native';
const binary = value => {
 if (value instanceof ArrayBuffer) return value;
 if (!ArrayBuffer.isView(value)) throw Error('Expected binary data');
 return new Uint8Array(value.buffer,value.byteOffset,value.byteLength).slice().buffer;
};
const frontier = values => {
 if(!Array.isArray(values)||values.length>64)throw Error('INVALID_FRONTIERS');
 const seen=new Set();const ids=values.map(value=>{
  if(!value||typeof value.peer!=='string'||! /^(0|[1-9][0-9]{0,19})$/.test(value.peer)||!Number.isSafeInteger(value.counter)||value.counter<0||value.counter>2147483647)throw Error('INVALID_FRONTIERS');
  const peer=BigInt(value.peer);if(peer>18446744073709551615n)throw Error('INVALID_FRONTIERS');const key=value.peer+':'+value.counter;if(seen.has(key))throw Error('INVALID_FRONTIERS');seen.add(key);return {peer,counter:value.counter};
 });return Frontiers.fromIds(ids);
};
const ids = value => value.toVec().map(({peer,counter})=>({peer:String(peer),counter}));
class Vector {
 constructor(native) {this.native=native;}
 toJSON() {return new Map([...this.native.toHashmap()].map(([peer,counter])=>[String(peer),counter]));}
}
class MapView {
 constructor(native) {this.native=native;}
 get(key) {const value=this.native.getDeepValue();return Object.prototype.hasOwnProperty.call(value,key)?value[key]:undefined;}
 set(key,value) {this.native.set(key,value);}
 delete(key) {this.native.delete_(key);}
 toJSON() {return this.native.getDeepValue();}
}
export class LoroDoc {
 constructor(native = new NativeDoc()) {this.native=native;}
 setPeerId(peer) {this.native.setPeerId(BigInt(peer));}
 getMap(name) {return new MapView(this.native.getMap(name));}
 toJSON() {return this.native.toJSON();}
 commit() {this.native.commit();}
 oplogVersion() {return new Vector(this.native.oplogVersion());}
 frontiers() {return ids(this.native.stateFrontiers());}
 import(value) {return this.native.import_(binary(value));}
 importBatch(values) {return this.native.importBatch(values.map(binary));}
 export(options) {
  if(options.mode==='snapshot') return new Uint8Array(this.native.exportSnapshot());
  if(options.mode==='update') return new Uint8Array(this.native.exportUpdates(options.from?.native ?? new VersionVector()));
  throw Error('Unsupported export mode');
 }
 fork() {return this.forkAt(this.frontiers());}
 forkAt(value) {
  // Unlike native forkAt, exportSnapshotAt returns an error for unknown IDs.
  const snapshot=this.native.exportSnapshotAt(frontier(value));
  const fork=new NativeDoc();fork.import_(snapshot);return new LoroDoc(fork);
 }
 exportJsonUpdates(start,end,compress=true) {
  const a=start?.native ?? new VersionVector(),b=end?.native ?? this.native.oplogVersion();
  const text=compress ? this.native.exportJsonUpdates(a,b) : this.native.exportJsonUpdatesWithoutPeerCompression(a,b);
  return JSON.parse(text);
 }
}
export function decodeImportBlobMeta(value,checkChecksum) {
 const m=decodeNative(binary(value),checkChecksum);
 return {...m,startFrontiers:ids(m.startFrontiers),partialStartVersionVector:new Vector(m.partialStartVv),partialEndVersionVector:new Vector(m.partialEndVv)};
}
