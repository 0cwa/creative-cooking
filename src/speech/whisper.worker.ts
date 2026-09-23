import { env, pipeline } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/whisper-tiny';

let transcriberPromise: Promise<any> | null = null;

function configureRuntime(allowRemote: boolean): void {
  env.useBrowserCache = true;
  env.allowRemoteModels = allowRemote;
  env.allowLocalModels = !allowRemote;
}

async function getTranscriber(
  allowRemote: boolean,
  progressCallback?: (progress: Record<string, unknown>) => void
): Promise<any> {
  if (!transcriberPromise) {
    configureRuntime(allowRemote);
    transcriberPromise = pipeline(
      'automatic-speech-recognition',
      MODEL_ID,
      {
        device: 'webgpu',
        dtype: {
          encoder_model: 'fp32',
          decoder_model_merged: 'q4'
        },
        progress_callback: progressCallback
      }
    );
  }
  return transcriberPromise;
}

async function load(allowRemote: boolean): Promise<void> {
  try {
    self.postMessage({ status: 'loading', message: allowRemote ? 'Downloading local voice model…' : 'Opening local voice model…' });
    const transcriber = await getTranscriber(allowRemote, (progress) => {
      self.postMessage(progress);
    });

    self.postMessage({ status: 'loading', message: 'Warming up local voice model…' });
    await transcriber(new Float32Array(16_000), {
      language: 'en',
      max_new_tokens: 1
    });

    self.postMessage({ status: 'ready' });
  } catch (error) {
    self.postMessage({
      status: 'error',
      message: error instanceof Error ? error.message : 'The local voice model could not be loaded.'
    });
  }
}

async function transcribe(audio: Float32Array, language?: string): Promise<void> {
  try {
    const transcriber = await getTranscriber(false);
    const options: Record<string, unknown> = {
      return_timestamps: true
    };
    if (language) options.language = language;

    const output = await transcriber(audio, options);
    self.postMessage({
      status: 'complete',
      result: {
        text: typeof output?.text === 'string' ? output.text : '',
        chunks: Array.isArray(output?.chunks)
          ? output.chunks.map((chunk: any) => ({
              text: typeof chunk?.text === 'string' ? chunk.text : '',
              timestamp: Array.isArray(chunk?.timestamp)
                ? [chunk.timestamp[0] ?? null, chunk.timestamp[1] ?? null]
                : undefined
            }))
          : undefined
      }
    });
  } catch (error) {
    self.postMessage({
      status: 'error',
      message: error instanceof Error ? error.message : 'Local transcription failed.'
    });
  }
}

self.addEventListener('message', (event: MessageEvent) => {
  const { type, data } = event.data ?? {};
  if (type === 'load') {
    void load(Boolean(data?.allowRemote));
  } else if (type === 'transcribe' && data?.audio instanceof Float32Array) {
    void transcribe(data.audio, typeof data.language === 'string' ? data.language : undefined);
  }
});
