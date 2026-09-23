import { expect, test } from '@playwright/test';

test('downloaded Whisper fallback keeps Start/Stop UX and never enables remote model loading', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: async () => ({}) }
    });

    const required = [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'onnx/encoder_model.onnx',
      'onnx/decoder_model_merged_q4.onnx'
    ];
    Object.defineProperty(window, 'caches', {
      configurable: true,
      value: {
        open: async () => ({
          keys: async () => required.map((file) =>
            new Request(`https://huggingface.co/onnx-community/whisper-tiny/resolve/main/${file}`)
          ),
          delete: async () => true
        })
      }
    });

    const track = { stop() {} };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [track]
        })
      }
    });

    class FakeAudioContext {
      sampleRate = 16000;
      destination = {};
      async resume() {}
      async close() {}
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createGain() {
        return { gain: { value: 1 }, connect() {}, disconnect() {} };
      }
      createScriptProcessor() {
        const processor = {
          onaudioprocess: null,
          connect() {
            setTimeout(() => {
              processor.onaudioprocess?.({
                inputBuffer: {
                  getChannelData: () => new Float32Array(16000).fill(0.05)
                }
              });
            }, 20);
          },
          disconnect() {}
        };
        return processor;
      }
    }
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: FakeAudioContext
    });

    class FakeWorker {
      onmessage = null;
      onerror = null;

      postMessage(message) {
        if (message.type === 'load') {
          window.__whisperAllowRemote = message.data?.allowRemote;
          setTimeout(() => this.onmessage?.({ data: { status: 'ready' } }), 10);
        } else if (message.type === 'transcribe') {
          window.__whisperTranscriptions = (window.__whisperTranscriptions ?? 0) + 1;
          setTimeout(() => this.onmessage?.({
            data: {
              status: 'complete',
              result: {
                text: 'tomatoes and basil',
                chunks: [{ text: 'tomatoes and basil', timestamp: [0, 1] }]
              }
            }
          }), 10);
        }
      }

      terminate() {}
    }
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      value: FakeWorker
    });

    class FakeSpeechRecognition {
      static async available() { return 'available'; }
      static async install() { return true; }
      start() { this.onstart?.(); }
      stop() { this.onend?.(); }
      abort() {}
    }
    Object.defineProperty(window, 'SpeechRecognition', {
      configurable: true,
      value: FakeSpeechRecognition
    });
  });

  await page.goto('./chef');
  const composer = page.getByLabel('Message Chef');

  await expect(page.getByLabel('Use browser dictation engine')).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Use Whisper dictation engine').click();
  await expect(page.getByLabel('Use Whisper dictation engine')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('Start dictation')).toBeEnabled();
  await page.getByLabel('Start dictation').click();
  await expect(page.getByLabel('Stop dictation')).toBeVisible();
  await expect(composer).toHaveValue('tomatoes and basil', { timeout: 5000 });

  expect(await page.evaluate(() => window.__whisperAllowRemote)).toBe(false);
  expect(await page.evaluate(() => window.__whisperTranscriptions ?? 0)).toBeGreaterThan(0);

  await page.getByLabel('Stop dictation').click();
  await expect(page.getByLabel('Start dictation')).toBeVisible();
  await expect(composer).toBeEditable();
  await composer.fill('tomatoes and basil, please');
  await expect(composer).toHaveValue('tomatoes and basil, please');
});
