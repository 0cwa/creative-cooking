import { expect, test } from '@playwright/test';

test('PR screenshot: Chef dictation engine selector', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.addInitScript(() => {
    class FakeSpeechRecognition {
      static async available() { return 'available'; }
      static async install() { return true; }
      start() { this.onstart?.(); }
      stop() { this.onend?.(); }
      abort() {}
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeSpeechRecognition });
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({}) } });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [] }) }
    });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: class {} });

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
  });

  await page.goto('./chef');
  await page.getByLabel('Use Whisper dictation engine').click();
  await expect(page.getByLabel('Use Whisper dictation engine')).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({
    path: 'test-results/pr-screenshots/dictation-engine-selector.png',
    fullPage: false
  });
});

test('PR screenshot: voice model download progress', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: async () => ({}) }
    });
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => ({ usage: 0, quota: 2 * 1024 * 1024 * 1024 }),
        persisted: async () => true
      }
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [] }) }
    });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: class {} });
    Object.defineProperty(window, 'caches', {
      configurable: true,
      value: {
        open: async () => ({
          keys: async () => [],
          delete: async () => true
        })
      }
    });

    class FakeWorker {
      onmessage = null;
      onerror = null;
      postMessage(message) {
        if (message.type !== 'load' || !message.data?.allowRemote) return;
        setTimeout(() => this.onmessage?.({
          data: {
            status: 'progress',
            file: 'onnx/encoder_model.onnx',
            loaded: 58 * 1024 * 1024,
            total: 100 * 1024 * 1024,
            progress: 58
          }
        }), 50);
      }
      terminate() {}
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: FakeWorker });
  });

  await page.goto('./settings');
  await page.getByText('Dictation · Whisper Tiny').scrollIntoViewIfNeeded();
  await page.getByLabel('Download local voice model').click();
  await expect(page.getByRole('progressbar')).toBeVisible();
  await page.screenshot({
    path: 'test-results/pr-screenshots/voice-model-download-progress.png',
    fullPage: false
  });
});
