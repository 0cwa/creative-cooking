import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/creative-cooking/';
const output = process.argv[3] ?? 'artifacts/loro/web-browser.json';
const screenshot = process.argv[4] ?? 'artifacts/loro/web-browser.png';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack ?? error)));
  page.on('requestfailed', (request) => failedRequests.push({
    url: request.url(),
    error: request.failure()?.errorText ?? null
  }));

  const response = await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const status = response?.status() ?? null;
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const html = await page.content().catch(() => '');
  fs.writeFileSync('artifacts/loro/web-browser-page.html', html);
  await page.screenshot({ path: screenshot, fullPage: true });

  const locator = page.getByTestId('loro-web-result');
  const count = await locator.count();
  const result = count > 0 ? await locator.textContent() : null;
  const detailLocator = page.getByTestId('loro-web-detail');
  const detail = (await detailLocator.count()) > 0 ? await detailLocator.textContent() : null;

  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => ({
    name: entry.name,
    transferSize: 'transferSize' in entry ? entry.transferSize : 0,
    encodedBodySize: 'encodedBodySize' in entry ? entry.encodedBodySize : 0,
    decodedBodySize: 'decodedBodySize' in entry ? entry.decodedBodySize : 0
  })));

  const outputValue = {
    pass: result === 'LORO WEB RUNTIME PASS',
    url,
    status,
    result,
    detail,
    bodyText,
    resources,
    consoleMessages,
    pageErrors,
    failedRequests
  };
  fs.writeFileSync(output, JSON.stringify(outputValue, null, 2));
  console.log(JSON.stringify(outputValue, null, 2));
  assert.equal(status, 200);
  assert.equal(result, 'LORO WEB RUNTIME PASS');
  assert.deepEqual(pageErrors, []);
} finally {
  await browser.close();
}
