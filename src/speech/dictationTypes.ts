export type DictationStatus =
  | 'idle'
  | 'checking'
  | 'installing-language'
  | 'loading-model'
  | 'listening'
  | 'stopping'
  | 'error';

export type DictationSnapshot = {
  status: DictationStatus;
  finalText: string;
  interimText: string;
  error?: string;
};

export type DictationController = {
  start(options: {
    lang: string;
    onChange: (snapshot: DictationSnapshot) => void;
  }): Promise<void>;
  stop(): void;
  dispose(): void;
};

export type OnDeviceDictationSupport = {
  available: boolean;
  backend: 'web-speech' | 'whisper' | 'none';
  reason?: string;
};
