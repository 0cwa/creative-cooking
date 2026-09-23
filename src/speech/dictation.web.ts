import type {
  DictationController,
  DictationSnapshot,
  DictationStatus,
  OnDeviceDictationSupport
} from './dictationTypes';

type SpeechPackAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  length: number;
  [index: number]: { transcript: string } | undefined;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike | undefined;
  };
};

type SpeechRecognitionErrorEventLike = {
  error: string;
  message?: string;
};

export type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  processLocally: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
};

type SpeechRecognitionOptions = {
  langs: string[];
  processLocally: true;
  quality?: 'dictation';
};

export type SpeechRecognitionConstructorLike = {
  new(): SpeechRecognitionLike;
  available(options: SpeechRecognitionOptions): Promise<SpeechPackAvailability>;
  install(options: SpeechRecognitionOptions): Promise<boolean>;
};

type Schedule = (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
type CancelSchedule = (handle: ReturnType<typeof setTimeout>) => void;

const RESTART_DELAY_MS = 250;

function whisperFallbackSupport(): { available: boolean; reason?: string } {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { available: false, reason: 'Local voice-model dictation is available only in the web app.' };
  }

  const gpu = (navigator as Navigator & { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
  if (!gpu?.requestAdapter) {
    return { available: false, reason: 'This browser does not provide WebGPU for the local voice model.' };
  }
  if (typeof Worker === 'undefined') {
    return { available: false, reason: 'This browser does not provide Web Workers for the local voice model.' };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { available: false, reason: 'This browser cannot capture microphone audio for local dictation.' };
  }
  if (!window.AudioContext) {
    return { available: false, reason: 'This browser does not provide Web Audio for local dictation.' };
  }
  if (typeof caches === 'undefined') {
    return { available: false, reason: 'This browser cannot cache the local voice model.' };
  }

  return { available: true };
}

class LazyWhisperDictationController implements DictationController {
  private delegate: DictationController | null = null;
  private disposed = false;

  async start(options: {
    lang: string;
    onChange: (snapshot: DictationSnapshot) => void;
  }): Promise<void> {
    if (this.disposed) return;
    if (!this.delegate) {
      const module = await import('./whisperModel');
      if (this.disposed) return;
      this.delegate = new module.WhisperDictationController();
    }
    await this.delegate.start(options);
  }

  stop(): void {
    this.delegate?.stop();
  }

  dispose(): void {
    this.disposed = true;
    this.delegate?.dispose();
    this.delegate = null;
  }
}

function appendSpeech(existing: string, next: string): string {
  const left = existing.replace(/\s+/g, ' ').trim();
  const right = next.replace(/\s+/g, ' ').trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

function speechRecognitionConstructor(): SpeechRecognitionConstructorLike | null {
  const value = (globalThis as typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructorLike;
  }).SpeechRecognition;

  if (!value || typeof value.available !== 'function' || typeof value.install !== 'function') {
    return null;
  }
  return value;
}

const ENGLISH_LANGUAGE_FALLBACKS = ['en-US', 'en-GB', 'en-AU', 'en-CA', 'en'] as const;

function englishLanguageCandidates(): string[] {
  return [...ENGLISH_LANGUAGE_FALLBACKS];
}

function recognitionErrorMessage(error: SpeechRecognitionErrorEventLike, lang: string): string {
  switch (error.error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission is blocked. Allow microphone access for this site, then try dictation again.';
    case 'audio-capture':
      return 'No microphone is available. Check your microphone and browser permissions, then try again.';
    case 'language-not-supported':
    case 'language-unavailable':
      return `On-device English dictation is not available in this browser (${lang} failed).`;
    default:
      return error.message?.trim() || 'On-device dictation stopped unexpectedly. Try again.';
  }
}

async function withDictationQuality<T>(
  action: (options: SpeechRecognitionOptions) => Promise<T>,
  lang: string
): Promise<T> {
  const options: SpeechRecognitionOptions = {
    langs: [lang],
    processLocally: true,
    quality: 'dictation'
  };

  try {
    return await action(options);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return action({ langs: [lang], processLocally: true });
  }
}

export class WebSpeechDictationController implements DictationController {
  private recognition: SpeechRecognitionLike | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private desiredActive = false;
  private disposed = false;
  private finalText = '';
  private interimText = '';
  private status: DictationStatus = 'idle';
  private onChange: ((snapshot: DictationSnapshot) => void) | null = null;
  private lang: string;
  private readonly Recognition: SpeechRecognitionConstructorLike;
  private readonly schedule: Schedule;
  private readonly cancelSchedule: CancelSchedule;

  constructor(
    Recognition: SpeechRecognitionConstructorLike,
    lang: string,
    schedule: Schedule = (callback, delayMs) => setTimeout(callback, delayMs),
    cancelSchedule: CancelSchedule = (handle) => clearTimeout(handle)
  ) {
    this.Recognition = Recognition;
    this.lang = lang || 'en-US';
    this.schedule = schedule;
    this.cancelSchedule = cancelSchedule;
  }

  async start(options: {
    lang: string;
    onChange: (snapshot: DictationSnapshot) => void;
  }): Promise<void> {
    if (this.disposed || this.desiredActive) return;

    this.clearRestart();
    this.lang = 'en-US';
    this.onChange = options.onChange;
    this.finalText = '';
    this.interimText = '';
    this.desiredActive = true;
    this.emit('checking');

    try {
      for (const candidate of englishLanguageCandidates()) {
        if (!this.desiredActive || this.disposed) {
          this.emit('idle');
          return;
        }

        const availability = await withDictationQuality(
          (speechOptions) => this.Recognition.available(speechOptions),
          candidate
        );

        if (availability === 'unavailable') continue;

        this.lang = candidate;
        if (availability !== 'available') {
          this.emit('installing-language');
          const installed = await withDictationQuality(
            (speechOptions) => this.Recognition.install(speechOptions),
            candidate
          );
          if (!installed) continue;
        }

        if (!this.desiredActive || this.disposed) {
          this.emit('idle');
          return;
        }

        this.startSession();
        return;
      }

      this.fail('On-device English dictation is not available in this browser. Try the downloaded Whisper engine instead.');
    } catch (error) {
      if (!this.desiredActive || this.disposed) return;
      this.fail(error instanceof Error && error.message
        ? `On-device dictation could not start: ${error.message}`
        : 'On-device dictation could not start.');
    }
  }

  stop(): void {
    if (this.disposed) return;
    this.desiredActive = false;
    this.clearRestart();

    if (!this.recognition) {
      this.emit('idle');
      return;
    }

    this.emit('stopping');
    try {
      this.recognition.stop();
    } catch {
      this.recognition = null;
      this.emit('idle');
    }
  }

  dispose(): void {
    this.desiredActive = false;
    this.disposed = true;
    this.clearRestart();
    const recognition = this.recognition;
    this.recognition = null;
    try {
      recognition?.abort?.();
    } catch {
      // Ignore browser teardown failures during unmount.
    }
    this.onChange = null;
  }

  private startSession(): void {
    if (!this.desiredActive || this.disposed || this.recognition) return;

    const recognition = new this.Recognition();
    this.recognition = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.lang;
    recognition.processLocally = true;

    recognition.onstart = () => {
      if (this.recognition !== recognition || !this.desiredActive) return;
      this.emit('listening');
    };

    recognition.onresult = (event) => {
      if (this.recognition !== recognition || !this.desiredActive) return;

      const interimParts: string[] = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript ?? '';
        if (!transcript) continue;

        if (result?.isFinal) {
          if (index >= event.resultIndex) {
            this.finalText = appendSpeech(this.finalText, transcript);
          }
        } else {
          interimParts.push(transcript);
        }
      }

      this.interimText = interimParts.join(' ').trim();
      this.emit('listening');
    };

    recognition.onerror = (error) => {
      if (this.recognition !== recognition) return;
      if (error.error === 'no-speech') return;
      if (error.error === 'aborted') return;
      this.fail(recognitionErrorMessage(error, this.lang));
    };

    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.recognition = null;
      if (this.disposed) return;

      if (this.desiredActive) {
        this.restartTimer = this.schedule(() => {
          this.restartTimer = null;
          this.startSession();
        }, RESTART_DELAY_MS);
      } else if (this.status !== 'error') {
        this.emit('idle');
      }
    };

    try {
      recognition.start();
    } catch (error) {
      this.recognition = null;
      this.fail(error instanceof Error && error.message
        ? `On-device dictation could not start: ${error.message}`
        : 'On-device dictation could not start.');
    }
  }

  private fail(message: string): void {
    this.desiredActive = false;
    this.clearRestart();
    const recognition = this.recognition;
    this.recognition = null;
    try {
      recognition?.abort?.();
    } catch {
      // Ignore cleanup failures after a recognition error.
    }
    this.emit('error', message);
  }

  private emit(status: DictationStatus, error?: string): void {
    this.status = status;
    this.onChange?.({
      status,
      finalText: this.finalText,
      interimText: this.interimText,
      ...(error ? { error } : {})
    });
  }

  private clearRestart(): void {
    if (this.restartTimer === null) return;
    this.cancelSchedule(this.restartTimer);
    this.restartTimer = null;
  }
}

export function getOnDeviceDictationSupport(
  engine: 'browser' | 'whisper' = 'browser'
): OnDeviceDictationSupport {
  if (engine === 'browser') {
    return speechRecognitionConstructor()
      ? { available: true, backend: 'browser' }
      : {
        available: false,
        backend: 'browser',
        reason: 'Browser on-device speech is unavailable. Use the downloaded Whisper engine instead.'
      };
  }

  const whisper = whisperFallbackSupport();
  return whisper.available
    ? { available: true, backend: 'whisper' }
    : {
      available: false,
      backend: 'whisper',
      reason: whisper.reason ?? 'The local Whisper dictation engine is unavailable in this browser.'
    };
}

export function getPreferredDictationLanguage(): string {
  return 'en-US';
}

export function createDictationController(
  engine: 'browser' | 'whisper' = 'browser'
): DictationController {
  if (engine === 'browser') {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      throw new Error('Browser on-device speech is unavailable. Use the downloaded Whisper engine instead.');
    }
    return new WebSpeechDictationController(Recognition, 'en-US');
  }

  const whisper = whisperFallbackSupport();
  if (whisper.available) {
    return new LazyWhisperDictationController();
  }

  throw new Error(whisper.reason ?? 'The local Whisper dictation engine is unavailable in this browser.');
}
