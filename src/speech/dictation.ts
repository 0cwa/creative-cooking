import type { DictationController, OnDeviceDictationSupport } from './dictationTypes';

export function getOnDeviceDictationSupport(): OnDeviceDictationSupport {
  return {
    available: false,
    backend: 'none',
    reason: 'On-device dictation is currently available only in the web app.'
  };
}

export function getPreferredDictationLanguage(): string {
  return 'en-US';
}

export function createDictationController(): DictationController {
  throw new Error('On-device dictation is not available on this platform.');
}
