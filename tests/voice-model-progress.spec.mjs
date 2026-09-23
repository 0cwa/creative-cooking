import { expect, test } from '@playwright/test';

test('voice model download shows overall percent and MB progress', async ({ page }) => {
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

    let cached = false;
    Object.defineProperty(window, 'caches', {
      configurable: true,
      value: {
        open: async () => ({
          keys: async () => cached ? [
            'config.json',
            'generation_config.json',
            'preprocessor_config.json',
            'tokenizer.json',
            'onnx/encoder_model.onnx',
            'onnx/decoder_model_merged_q4.onnx'
          ].map((file) => new Request(`https://huggingface.co/onnx-community/whisper-tiny/resolve/main/${file}`)) : [],
          delete: async () => true
        })
      }
    });

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [] }) }
    });
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: class {}
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
            loaded: 42 * 1024 * 1024,
            total: 100 * 1024 * 1024,
            progress: 42
          }
        }), 30);
        setTimeout(() => {
          cached = true;
          this.onmessage?.({ data: { status: 'ready' } });
        }, 800);
      }
      terminate() {}
    }
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      value: FakeWorker
    });
  });

  await page.goto('./settings');
  await page.getByLabel('Download local voice model').click();

  const progress = page.getByRole('progressbar');
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute('aria-valuenow', /[1-9][0-9]?/);
  await expect(page.getByText(/MB \/ .*MB/)).toBeVisible();

  await expect(page.getByText('Downloaded', { exact: true }).first()).toBeVisible({ timeout: 5000 });
});
