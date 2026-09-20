import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PersistedState } from '@/domain/types';

const STATE_KEY = 'creative-cooking-state-v1';

export async function loadState(): Promise<Partial<PersistedState> | null> {
  const raw = await AsyncStorage.getItem(STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<PersistedState>;
  } catch {
    return null;
  }
}

export async function saveState(state: PersistedState): Promise<void> {
  await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state));
}
