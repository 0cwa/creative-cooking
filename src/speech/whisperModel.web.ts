import type {
  DictationController,
  DictationSnapshot,
  DictationStatus
} from './dictationTypes';
import {
  applyWhisperWindow,
  type WhisperWindowResult
} from './whisperTranscript';

export const WHISPER_MODEL_ID = 'onnx-community/whisper-tiny';
export const WHISPER_MODEL_ESTIMATED_DOWNLOAD_MB = 130;
export const WHISPER_RECOMMENDED_FREE_BYTES = 250 * 1024 * 1024;
const WHISPER_MODEL_ESTIMATED_DOWNLOAD_BYTES = WHISPER_MODEL_ESTIMATED_DOWNLOAD_MB * 1024 * 1024;

export type WhisperDownloadProgress = {
  phase: 'downloading' | 'warming' | 'ready';
  message: string;
  percent: number;
  loadedBytes: number;
  totalBytes: number;
};

const CACHE_NAME = 'transformers-cache';
const MODEL_PATH_MARKER = '/onnx-community/whisper-tiny/resolve/main/';
const REQUIRED_CACHE_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'onnx/encoder_model.onnx',
  'onnx/decoder_model_merged_q4.onnx'
];
const TARGET_SAMPLE_RATE = 16_000;
const TRANSCRIBE_INTERVAL_MS = 1_500;
const MIN_TRANSCRIBE_SECONDS = 0.65;

type NavigatorWithGpu = Navigator & {
  gpu?: {
    requestAdapter?: () => Promise<unknown>;
  };
};

type WhisperWorkerMessage = {
  status?: string;
  message?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  result?: WhisperWindowResult;
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

function audioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? null;
}

export function getWhisperStaticSupport(): { available: boolean; reason?: string } {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { available: false, reason: 'Local voice-model dictation is available only in the web app.' };
  }
  if (!(navigator as NavigatorWithGpu).gpu?.requestAdapter) {
    return { available: false, reason: 'This browser does not provide WebGPU for the local voice model.' };
  }
  if (typeof Worker === 'undefined') {
    return { available: false, reason: 'This browser does not provide Web Workers for the local voice model.' };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { available: false, reason: 'This browser cannot capture microphone audio for local dictation.' };
  }
  if (!audioContextConstructor()) {
    return { available: false, reason: 'This browser does not provide Web Audio for local dictation.' };
  }
  if (typeof caches === 'undefined') {
    return { available: false, reason: 'This browser cannot cache the local voice model.' };
  }
  return { available: true };
}

export async function getWhisperModelCapabilities(): Promise<WhisperCapabilityResult> {
  const staticSupport = getWhisperStaticSupport();
  const gpu = typeof navigator !== 'undefined' ? (navigator as NavigatorWithGpu).gpu : undefined;
  let webGpu = false;
  try {
    webGpu = Boolean(gpu?.requestAdapter && await gpu.requestAdapter());
  } catch {
    webGpu = false;
  }

  const microphone = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
  const worker = typeof Worker !== 'undefined';
  const audioContext = Boolean(audioContextConstructor());
  const browserCache = typeof caches !== 'undefined';
  const estimate: StorageEstimate = typeof navigator !== 'undefined' && navigator.storage?.estimate
    ? await navigator.storage.estimate().catch(() => ({} as StorageEstimate))
    : {};
  const freeBytes = typeof estimate.quota === 'number' && typeof estimate.usage === 'number'
    ? Math.max(0, estimate.quota - estimate.usage)
    : undefined;
  const reasons: string[] = [];

  if (!staticSupport.available && staticSupport.reason) reasons.push(staticSupport.reason);
  if (staticSupport.available && !webGpu) reasons.push('A usable WebGPU adapter is not available for the local voice model.');
  if (freeBytes !== undefined && freeBytes < WHISPER_RECOMMENDED_FREE_BYTES) {
    reasons.push('At least 250 MB of free browser storage is recommended for the local voice model.');
  }

  return {
    available: reasons.length === 0,
    webGpu,
    worker,
    microphone,
    audioContext,
    browserCache,
    freeBytes,
    recommendedFreeBytes: WHISPER_RECOMMENDED_FREE_BYTES,
    reasons
  };
}

function isModelCacheRequest(url: string): boolean {
  try {
    return decodeURIComponent(new URL(url).pathname).includes(MODEL_PATH_MARKER);
  } catch {
    return false;
  }
}

export async function isWhisperModelCached(): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  const cache = await caches.open(CACHE_NAME);
  const requests = await cache.keys();
  const modelPaths = requests
    .filter((request) => isModelCacheRequest(request.url))
    .map((request) => decodeURIComponent(new URL(request.url).pathname));

  return REQUIRED_CACHE_FILES.every((file) =>
    modelPaths.some((pathname) => pathname.endsWith(`${MODEL_PATH_MARKER}${file}`))
  );
}

export async function deleteWhisperModel(): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(CACHE_NAME);
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((request) => isModelCacheRequest(request.url))
      .map((request) => cache.delete(request))
  );
}

function createWhisperWorker(): Worker {
  const base = (process.env.EXPO_PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  return new Worker(`${base}/whisper-worker.js`, { type: 'module' });
}

export async function downloadWhisperModel(
  onProgress?: (progress: WhisperDownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const capability = await getWhisperModelCapabilities();
  if (!capability.available) {
    throw new Error(capability.reasons.join(' ') || 'The local voice model is not supported on this device.');
  }

  if (signal?.aborted) throw new DOMException('The download was cancelled.', 'AbortError');

  const worker = createWhisperWorker();
  const files = new Map<string, { loaded: number; total: number }>();

  const emitProgress = (
    phase: WhisperDownloadProgress['phase'],
    message: string,
    forceComplete = false
  ) => {
    const totals = [...files.values()];
    const knownLoaded = totals.reduce((sum, item) => sum + item.loaded, 0);
    const knownTotal = totals.reduce((sum, item) => sum + item.total, 0);
    const totalBytes = Math.max(WHISPER_MODEL_ESTIMATED_DOWNLOAD_BYTES, knownTotal);
    const loadedBytes = forceComplete ? totalBytes : Math.min(knownLoaded, totalBytes);
    const percent = forceComplete
      ? 100
      : phase === 'warming'
        ? 99
        : Math.min(98, Math.round((loadedBytes / totalBytes) * 100));

    onProgress?.({ phase, message, percent, loadedBytes, totalBytes });
  };

  emitProgress('downloading', 'Preparing local voice-model download…');

  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        reject(new DOMException('The download was cancelled.', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      worker.onmessage = (event: MessageEvent<WhisperWorkerMessage>) => {
        const data = event.data ?? {};
        if (data.status === 'loading' && data.message) {
          const phase = /warming/i.test(data.message) ? 'warming' : 'downloading';
          emitProgress(phase, data.message);
        } else if (data.status === 'progress') {
          const file = data.file ?? 'model-file';
          const previous = files.get(file) ?? { loaded: 0, total: 0 };
          files.set(file, {
            loaded: typeof data.loaded === 'number' ? data.loaded : previous.loaded,
            total: typeof data.total === 'number' ? data.total : previous.total
          });
          emitProgress('downloading', `Downloading ${file.split('/').at(-1) ?? 'model file'}…`);
        } else if (data.status === 'ready') {
          emitProgress('ready', 'Local voice model ready.', true);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        } else if (data.status === 'error') {
          signal?.removeEventListener('abort', onAbort);
          reject(new Error(data.message || 'The local voice model could not be downloaded.'));
        }
      };

      worker.onerror = (event) => {
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(event.message || 'The local voice-model worker failed.'));
      };

      worker.postMessage({ type: 'load', data: { allowRemote: true } });
    });

    if (!(await isWhisperModelCached())) {
      throw new Error('The local voice model finished loading but its browser cache is incomplete.');
    }
  } finally {
    worker.terminate();
  }
}

function appendFloatChunks(chunks: Float32Array[], sampleCount: number): Float32Array {
  const result = new Float32Array(sampleCount);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= sampleCount) break;
    const length = Math.min(chunk.length, sampleCount - offset);
    result.set(chunk.subarray(0, length), offset);
    offset += length;
  }
  return result;
}

function dropSamples(chunks: Float32Array[], count: number): { chunks: Float32Array[]; dropped: number } {
  let remaining = Math.max(0, count);
  let dropped = 0;
  const next: Float32Array[] = [];

  for (const chunk of chunks) {
    if (remaining >= chunk.length) {
      remaining -= chunk.length;
      dropped += chunk.length;
      continue;
    }
    if (remaining > 0) {
      next.push(chunk.subarray(remaining));
      dropped += remaining;
      remaining = 0;
    } else {
      next.push(chunk);
    }
  }

  return { chunks: next, dropped };
}

function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input;
  if (!input.length) return input;

  const outputLength = Math.max(1, Math.round(input.length * outputRate / inputRate));
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const mix = position - left;
    output[index] = input[left] * (1 - mix) + input[right] * mix;
  }

  return output;
}

function whisperLanguage(lang: string): string | undefined {
  const primary = lang.trim().toLowerCase().split(/[-_]/)[0];
  if (!/^[a-z]{2}$/.test(primary)) return undefined;
  if (primary === 'nb' || primary === 'nn') return 'no';
  return primary;
}

export class WhisperDictationController implements DictationController {
  private worker: Worker | null = null;
  private workerReady = false;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private audioChunks: Float32Array[] = [];
  private totalSamples = 0;
  private inputSampleRate = TARGET_SAMPLE_RATE;
  private processing = false;
  private desiredActive = false;
  private disposed = false;
  private finalText = '';
  private interimText = '';
  private lang = 'en-US';
  private onChange: ((snapshot: DictationSnapshot) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private snapshotSamples = 0;
  private snapshotDuration = 0;
  private snapshotFinalize = false;

  async start(options: {
    lang: string;
    onChange: (snapshot: DictationSnapshot) => void;
  }): Promise<void> {
    if (this.disposed || this.desiredActive) return;

    this.lang = options.lang || 'en-US';
    this.onChange = options.onChange;
    this.audioChunks = [];
    this.totalSamples = 0;
    this.inputSampleRate = TARGET_SAMPLE_RATE;
    this.finalText = '';
    this.interimText = '';
    this.desiredActive = true;
    this.emit('checking');

    try {
      const [capability, cached] = await Promise.all([
        getWhisperModelCapabilities(),
        isWhisperModelCached()
      ]);
      if (!this.desiredActive || this.disposed) return;
      if (!capability.available) throw new Error(capability.reasons.join(' '));
      if (!cached) {
        throw new Error('The local voice model is not downloaded. Open Settings → Local models and download it first.');
      }

      await this.ensureWorker();
      if (!this.desiredActive || this.disposed) return;
      await this.beginCapture();
    } catch (error) {
      if (!this.desiredActive || this.disposed) return;
      this.fail(error instanceof Error ? error.message : 'Local voice-model dictation could not start.');
    }
  }

  stop(): void {
    if (this.disposed || !this.desiredActive) return;
    this.desiredActive = false;
    this.clearTimer();
    this.emit('stopping');
    this.stopCapture();

    if (!this.processing) {
      if (this.totalSamples > 0) this.transcribe(true);
      else this.finishStop();
    }
  }

  dispose(): void {
    this.desiredActive = false;
    this.disposed = true;
    this.clearTimer();
    this.stopCapture();
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    this.onChange = null;
  }

  private async ensureWorker(): Promise<void> {
    if (this.workerReady && this.worker) return;
    this.emit('loading-model');

    const worker = this.worker ?? createWhisperWorker();
    this.worker = worker;

    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WhisperWorkerMessage>) => {
        const data = event.data ?? {};
        if (data.status === 'loading' && data.message) {
          this.emit('loading-model');
        } else if (data.status === 'ready') {
          this.workerReady = true;
          resolve();
        } else if (data.status === 'complete' && data.result) {
          this.handleTranscription(data.result);
        } else if (data.status === 'error') {
          const error = new Error(data.message || 'The local voice model failed.');
          if (!this.workerReady) reject(error);
          else this.fail(error.message);
        }
      };

      worker.onerror = (event) => {
        const error = new Error(event.message || 'The local voice-model worker failed.');
        if (!this.workerReady) reject(error);
        else this.fail(error.message);
      };

      worker.postMessage({ type: 'load', data: { allowRemote: false } });
    });
  }

  private async beginCapture(): Promise<void> {
    if (!this.desiredActive) return;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!this.desiredActive || this.disposed) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const AudioContextCtor = audioContextConstructor();
    if (!AudioContextCtor) throw new Error('Web Audio is not available.');

    const audioContext = new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE });
    await audioContext.resume();

    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    processor.onaudioprocess = (event) => {
      if (!this.desiredActive) return;
      const input = event.inputBuffer.getChannelData(0);
      if (!input.length) return;
      const copy = new Float32Array(input);
      this.audioChunks.push(copy);
      this.totalSamples += copy.length;
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    this.stream = stream;
    this.audioContext = audioContext;
    this.inputSampleRate = audioContext.sampleRate;
    this.source = source;
    this.processor = processor;
    this.silentGain = silentGain;
    this.emit('listening');
    this.scheduleTranscription();
  }

  private scheduleTranscription(): void {
    this.clearTimer();
    if (!this.desiredActive || this.processing) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      const sampleRate = this.inputSampleRate;
      if (this.totalSamples / sampleRate >= MIN_TRANSCRIBE_SECONDS) {
        this.transcribe(false);
      } else {
        this.scheduleTranscription();
      }
    }, TRANSCRIBE_INTERVAL_MS);
  }

  private transcribe(finalize: boolean): void {
    if (!this.workerReady || !this.worker || this.processing || this.totalSamples <= 0) {
      if (finalize && !this.processing) this.finishStop();
      return;
    }

    const sampleRate = this.inputSampleRate;
    const sampleCount = this.totalSamples;
    const input = appendFloatChunks(this.audioChunks, sampleCount);
    const audio = resampleLinear(input, sampleRate, TARGET_SAMPLE_RATE);

    this.processing = true;
    this.snapshotSamples = sampleCount;
    this.snapshotDuration = sampleCount / sampleRate;
    this.snapshotFinalize = finalize;

    this.worker.postMessage({
      type: 'transcribe',
      data: {
        audio,
        language: whisperLanguage(this.lang)
      }
    }, [audio.buffer]);
  }

  private handleTranscription(result: WhisperWindowResult): void {
    if (!this.processing) return;

    const finalizeThisResult = this.snapshotFinalize || !this.desiredActive;
    const applied = applyWhisperWindow(
      this.finalText,
      result,
      this.snapshotDuration,
      finalizeThisResult
    );
    this.finalText = applied.finalText;
    this.interimText = applied.interimText;

    if (applied.dropSeconds > 0) {
      const sampleRate = this.inputSampleRate;
      const requestedDrop = Math.min(
        this.snapshotSamples,
        Math.round(applied.dropSeconds * sampleRate)
      );
      const dropped = dropSamples(this.audioChunks, requestedDrop);
      this.audioChunks = dropped.chunks;
      this.totalSamples = Math.max(0, this.totalSamples - dropped.dropped);
    }

    this.processing = false;
    this.snapshotSamples = 0;
    this.snapshotDuration = 0;
    this.snapshotFinalize = false;

    if (!this.desiredActive) {
      if (this.totalSamples > 0) {
        this.transcribe(true);
      } else {
        this.finishStop();
      }
      return;
    }

    this.emit('listening');
    this.scheduleTranscription();
  }

  private stopCapture(): void {
    this.source?.disconnect();
    this.processor?.disconnect();
    this.silentGain?.disconnect();
    if (this.processor) this.processor.onaudioprocess = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.audioContext?.close().catch(() => undefined);

    this.source = null;
    this.processor = null;
    this.silentGain = null;
    this.stream = null;
    this.audioContext = null;
  }

  private finishStop(): void {
    this.processing = false;
    this.interimText = '';
    this.audioChunks = [];
    this.totalSamples = 0;
    this.emit('idle');
  }

  private fail(message: string): void {
    this.desiredActive = false;
    this.processing = false;
    this.clearTimer();
    this.stopCapture();
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    this.emit('error', message);
  }

  private emit(status: DictationStatus, error?: string): void {
    this.onChange?.({
      status,
      finalText: this.finalText,
      interimText: this.interimText,
      ...(error ? { error } : {})
    });
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
