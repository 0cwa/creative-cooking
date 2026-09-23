import type { DictationController } from './dictationTypes';

export const WHISPER_MODEL_ID = 'onnx-community/whisper-tiny';
export const WHISPER_MODEL_ESTIMATED_DOWNLOAD_MB = 130;
export const WHISPER_RECOMMENDED_FREE_BYTES = 250 * 1024 * 1024;

export type WhisperDownloadProgress = {
  phase: 'downloading' | 'warming' | 'ready';
  message: string;
  percent: number;
  loadedBytes: number;
  totalBytes: number;
};

export type WhisperCapabilityResult = {
  available: boolean;
  webGpu: boolean;
  worker: boolean;
  microphone: boolean;
  audioContext: boolean;
  browserCache: boolean;
  freeBytes?: number;
  recommendedFreeBytes: number;
  reasons: string[];
};

export function getWhisperStaticSupport(): { available: boolean; reason?: string } {
  return {
    available: false,
    reason: 'Local voice-model dictation is currently available only in the web app.'
  };
}

export async function getWhisperModelCapabilities(): Promise<WhisperCapabilityResult> {
  return {
    available: false,
    webGpu: false,
    worker: false,
    microphone: false,
    audioContext: false,
    browserCache: false,
    recommendedFreeBytes: WHISPER_RECOMMENDED_FREE_BYTES,
    reasons: ['Local voice-model dictation is currently available only in the web app.']
  };
}

export async function isWhisperModelCached(): Promise<boolean> {
  return false;
}

export async function downloadWhisperModel(
  _onProgress?: (progress: WhisperDownloadProgress) => void,
  _signal?: AbortSignal
): Promise<void> {
  throw new Error('Local voice-model dictation is not available on this platform.');
}

export async function deleteWhisperModel(): Promise<void> {}

export class WhisperDictationController implements DictationController {
  async start(_options: {
    lang: string;
    onChange: (snapshot: import('./dictationTypes').DictationSnapshot) => void;
  }): Promise<void> {
    throw new Error('Local voice-model dictation is not available on this platform.');
  }
  stop(): void {}
  dispose(): void {}
}
