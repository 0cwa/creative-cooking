import { expect, test } from '@playwright/test';

test('on-device dictation stays active across browser ends until the user presses Stop', async ({ page }) => {
  await page.addInitScript(() => {
    let starts = 0;
    const localFlags = [];

    class FakeSpeechRecognition {
      static async available(options) {
        window.__speechOptions = options;
        return 'available';
      }

      static async install() {
        return true;
      }

      continuous = false;
      interimResults = false;
      lang = '';
      processLocally = false;
      onstart = null;
      onresult = null;
      onerror = null;
      onend = null;

      start() {
        starts += 1;
        localFlags.push(this.processLocally);
        window.__speechStarts = starts;
        window.__speechLocalFlags = localFlags;
        this.onstart?.();

        const phrase = starts === 1 ? 'tomatoes' : 'and basil';
        setTimeout(() => {
          const item = { 0: { transcript: phrase }, length: 1, isFinal: true };
          this.onresult?.({ resultIndex: 0, results: [item] });
          if (starts === 1) setTimeout(() => this.onend?.(), 10);
        }, 10);
      }

      stop() {
        this.onend?.();
      }

      abort() {}
    }

    Object.defineProperty(window, 'SpeechRecognition', {
      configurable: true,
      value: FakeSpeechRecognition
    });
  });

  await page.goto('./chef');
  const composer = page.getByLabel('Message Chef');

  await page.getByLabel('Start dictation').click();
  await expect(page.getByLabel('Stop dictation')).toBeVisible();
  await expect(composer).toHaveValue('tomatoes');
  await expect.poll(() => page.evaluate(() => window.__speechStarts ?? 0)).toBeGreaterThanOrEqual(2);
  await expect(composer).toHaveValue('tomatoes and basil');

  expect(await page.evaluate(() => window.__speechLocalFlags)).toEqual([true, true]);
  expect(await page.evaluate(() => window.__speechOptions.processLocally)).toBe(true);

  await page.getByLabel('Stop dictation').click();
  await expect(page.getByLabel('Start dictation')).toBeVisible();
  await expect(composer).toBeEditable();
  await composer.fill('tomatoes and basil, please');
  await expect(composer).toHaveValue('tomatoes and basil, please');
});
