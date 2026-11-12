import { LoroDoc } from 'loro-react-native';
import { NATIVE_WEB_BASE_SNAPSHOT, NATIVE_WEB_UPDATE } from './native-web-fixture';
import { runLoroScenario, type LoroConstructor, type LoroDocPort, type LoroListPort, type LoroMapPort } from './engine.shared';

type NativeDoc = InstanceType<typeof LoroDoc>;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

class NativeDocAdapter implements LoroDocPort {
  private readonly document: NativeDoc;

  constructor() {
    this.document = new LoroDoc();
  }

  setPeerId(peerId: string) {
    this.document.setPeerId(BigInt(peerId));
  }

  getMap(name: string): LoroMapPort {
    const map = this.document.getMap(name);
    return { set: (key, value) => map.set(key, value as never) };
  }

  getList(name: string): LoroListPort {
    const list = this.document.getList(name);
    return {
      insert: (index, value) => list.insert(index, value as never),
      delete: (index, count) => list.delete_(index, count),
    };
  }

  version() {
    return this.document.version();
  }

  export(options: { mode: 'snapshot' | 'update'; from?: unknown }): Uint8Array {
    if (options.mode === 'snapshot') return new Uint8Array(this.document.export({ mode: 'snapshot' }));
    return new Uint8Array(this.document.export({ mode: 'updates', from: options.from as never }));
  }

  import(bytes: Uint8Array) {
    return this.document.import_(toArrayBuffer(bytes));
  }

  importUpdateBatch(updates: Uint8Array[]) {
    return this.document.importBatch(updates.map(toArrayBuffer));
  }

  toJSON(): Record<string, unknown> {
    return this.document.toJSON() as Record<string, unknown>;
  }
}

export function runScenario(priorSnapshot?: Uint8Array) {
  return runLoroScenario(
    NativeDocAdapter as unknown as LoroConstructor,
    'loro-react-native',
    priorSnapshot,
    { baseSnapshot: NATIVE_WEB_BASE_SNAPSHOT, update: NATIVE_WEB_UPDATE },
  );
}
