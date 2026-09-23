import { expect, test } from '@playwright/test';

test('on-device dictation stays active across browser ends until the user presses Stop', async ({ page }) => {
  await page.addInitScript(() => {
    let starts = 0;
    const localFlags = [];

    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'en-DK'
    });

    class FakeSpeechRecognition {
      static async available(options) {
        window.__speechOptions = [...(window.__speechOptions ?? []), options];
        return options.langs[0] === 'en-US' ? 'available' : 'unavailable';
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
  const options = await page.evaluate(() => window.__speechOptions);
  expect(options[0].processLocally).toBe(true);
  expect(options[0].langs[0]).toBe('en-US');

  await page.getByLabel('Stop dictation').click();
  await expect(page.getByLabel('Start dictation')).toBeVisible();
  await expect(composer).toBeEditable();
  await composer.fill('tomatoes and basil, please');
  await expect(composer).toHaveValue('tomatoes and basil, please');
});


test('compact mic stays beside the composer and explains unavailable dictation', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'SpeechRecognition', {
      configurable: true,
      value: undefined
    });
  });

  await page.goto('./chef');

  const plus = page.getByLabel('Edit meal context', { exact: true });
  const mic = page.getByLabel('Start dictation');
  const composer = page.getByLabel('Message Chef');
  await expect(mic).toBeVisible();
  await expect(page.getByLabel('Use browser dictation engine')).toHaveCount(0);

  const [plusBox, micBox, composerBox] = await Promise.all([
    plus.boundingBox(),
    mic.boundingBox(),
    composer.boundingBox()
  ]);
  expect(plusBox).not.toBeNull();
  expect(micBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(plusBox.x + plusBox.width).toBeLessThan(micBox.x);
  expect(micBox.x + micBox.width).toBeLessThan(composerBox.x);

  await mic.click();
  await expect(page.getByText('Browser dictation unavailable')).toBeVisible();
  await expect(page.getByText(/switch to Whisper/i)).toBeVisible();

  await page.getByLabel('Open dictation settings').click();
  await expect(page.getByLabel('Use browser dictation engine')).toBeVisible();
  await expect(page.getByLabel('Use Whisper dictation engine')).toBeVisible();
  await expect(page.getByText('Dictation', { exact: true })).toBeInViewport();
});
