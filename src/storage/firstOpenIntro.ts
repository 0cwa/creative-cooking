import AsyncStorage from '@react-native-async-storage/async-storage';

const FIRST_OPEN_INTRO_KEY = 'creative-cooking-first-open-intro-v1';

export async function hasSeenFirstOpenIntro(): Promise<boolean> {
  return (await AsyncStorage.getItem(FIRST_OPEN_INTRO_KEY)) === '1';
}

export async function markFirstOpenIntroSeen(): Promise<void> {
  await AsyncStorage.setItem(FIRST_OPEN_INTRO_KEY, '1');
}
