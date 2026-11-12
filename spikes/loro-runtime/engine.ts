import { LoroDoc } from 'loro-crdt';
import { runLoroScenario, type LoroConstructor } from './engine.shared';

export function runScenario(priorSnapshot?: Uint8Array) {
  return runLoroScenario(LoroDoc as unknown as LoroConstructor, 'loro-crdt', priorSnapshot);
}
