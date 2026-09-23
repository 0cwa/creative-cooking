import type { DictationController, OnDeviceDictationSupport } from './dictationTypes';

export function getOnDeviceDictationSupport(): OnDeviceDictationSupport {
  return {
    available: false,
    reason: 'On-device dictation is currently available only in the web app.'
  };
}

export function getPreferredDictationLanguage(): string {\n  return 'en-US';\n}\n\nexport function createDictationController(): DictationController {
  throw new Error('On-device dictation is not available on this platform.');
}
