import { DEFAULT_STATE, migrateLegacySystemPrompt } from '@/domain/defaults';
import type { PersistedState } from '@/domain/types';
import { freshStateFromDefaults, parseBackupEnvelope, serializeBackupEnvelope } from './backupFormat';

export function serializeBackup(state: PersistedState): string {
  return serializeBackupEnvelope(state, new Date().toISOString());
}

export function parseBackup(raw: string): PersistedState {
  const state = parseBackupEnvelope(raw, DEFAULT_STATE);
  return {
    ...state,
    settings: {
      ...state.settings,
      systemPrompt: migrateLegacySystemPrompt(state.settings.systemPrompt)
    }
  };
}

export function freshDefaultState(): PersistedState {
  return freshStateFromDefaults(DEFAULT_STATE);
}
