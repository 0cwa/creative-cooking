import { DEFAULT_STATE } from '@/domain/defaults';
import type { PersistedState } from '@/domain/types';
import { freshStateFromDefaults, parseBackupEnvelope, serializeBackupEnvelope } from './backupFormat';

export function serializeBackup(state: PersistedState): string {
  return serializeBackupEnvelope(state, new Date().toISOString());
}

export function parseBackup(raw: string): PersistedState {
  return parseBackupEnvelope(raw, DEFAULT_STATE);
}

export function freshDefaultState(): PersistedState {
  return freshStateFromDefaults(DEFAULT_STATE);
}
