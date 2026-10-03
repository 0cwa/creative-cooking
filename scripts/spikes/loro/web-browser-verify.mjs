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
  page.on('console', (msg) => consoleMessages.push(msg.text()));
  await page.goto(url, { waitUntil: 'networkidle' });
  const result = await page.getByTestId('loro-web-result').textContent();
  const detail = await page.getByTestId('loro-web-detail').textContent();
  assert.equal(result, 'LORO WEB RUNTIME PASS');
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => ({
    name: entry.name,
    transferSize: 'transferSize' in entry ? entry.transferSize : 0,
    encodedBodySize: 'encodedBodySize' in entry ? entry.encodedBodySize : 0,
    decodedBodySize: 'decodedBodySize' in entry ? entry.decodedBodySize : 0
  })));
  await page.screenshot({ path: screenshot, fullPage: true });
  const outputValue = { pass: true, url, result, detail, resources, consoleMessages };
  fs.writeFileSync(output, JSON.stringify(outputValue, null, 2));
  console.log(JSON.stringify(outputValue, null, 2));
} finally {
  await browser.close();
}
