import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
const engine = process.argv[2];
assert.ok(['control','automerge','loro'].includes(engine));
const dir = 'artifacts/benchmark-parity';
fs.mkdirSync(dir, { recursive: true });
const url = 'http://127.0.0.1:4173/creative-cooking/benchmark-parity';
const browser = await chromium.launch({ headless: true });
const pageErrors = [], failedRequests = [], assets = [], cdpTransfers = [];
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.loadingFinished', event => cdpTransfers.push({ requestId: event.requestId, encodedDataLength: event.encodedDataLength }));
  page.on('pageerror', err => pageErrors.push(String(err?.stack ?? err)));
  page.on('requestfailed', req => failedRequests.push({ url: req.url(), error: req.failure()?.errorText }));
  page.on('response', response => {
    const reqUrl = response.url();
    if (!reqUrl.startsWith('http://127.0.0.1:4173/creative-cooking/')) return;
    assets.push({ url: reqUrl, status: response.status(),
      contentType: response.headers()['content-type'] ?? null,
      contentEncoding: response.headers()['content-encoding'] ?? null,
      contentLength: Number(response.headers()['content-length'] ?? 0) });
  });
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('parity-marker').filter({ hasText: 'PARITY PASS' }).waitFor({ timeout: 60000 });
  const detail = await page.getByTestId('parity-detail').textContent();
  const first = await page.evaluate(() => (window).__parityResult);
  assert.ok(first, 'window engine readiness');
  assert.equal(response?.status(), 200);
  assert.ok(assets.every(x => x.status === 200), 'all same-origin assets must load');
  assert.deepStrictEqual(pageErrors, []);
  assert.deepStrictEqual(failedRequests, []);
  const firstCdpBytes = cdpTransfers.reduce((n,x) => n + x.encodedDataLength, 0);
  if (engine !== 'control') {
    assert.equal(first.engine, engine);
    assert.equal(first.snapshotLoaded, true);
    assert.equal(first.duplicateSafe, true);
    assert.ok(first.bytes > 0 && first.incrementalBytes > 0);
    const count = assets.length;
    const failures = failedRequests.length;
    // All local document operations must remain functional with network access disabled.
    await context.setOffline(true);
    const offline = await page.evaluate(() => (window).__parityOffline());
    assert.equal(offline.offline, true);
    assert.equal(offline.revision, first.revision + 1);
    assert.equal(assets.length, count, 'no network request while editing offline');
    assert.equal(failedRequests.length, failures, 'no failed background request from an offline edit');
    await context.setOffline(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('parity-marker').filter({ hasText: 'PARITY PASS' }).waitFor({ timeout: 60000 });
    const second = await page.evaluate(() => (window).__parityResult);
    assert.ok(second.prior >= offline.revision, 'local snapshot survived a refresh');
    assert.deepStrictEqual(pageErrors, []);
    if (engine === 'loro') {
      assert.ok(assets.some(x => x.url.endsWith('/loro_wasm_bg.wasm') && x.status === 200),
        'Loro WASM must load at the correct Pages subpath');
    }
  }
  await page.screenshot({ path: dir + '/chromium-' + engine + '.png', fullPage: true });
  const perf = await page.evaluate(() => performance.getEntriesByType('resource').map(item => ({
    name:item.name, transferSize:item.transferSize, encodedBodySize:item.encodedBodySize,
    decodedBodySize:item.decodedBodySize
  })));
  const output = { engine, pass: true, pageUrl: url, initialResponse: response?.status(),
    first, pageErrors, failedRequests, assets, perfResources: perf,
    initialCdpEncodedBytes: firstCdpBytes,
    totalWithRefreshCdpEncodedBytes: cdpTransfers.reduce((n,x) => n + x.encodedDataLength, 0),
    transportNote:'Initial CDP bytes include initial navigation/response headers (HTTP compression from server). TotalWithRefresh adds reload traffic. Browser service workers blocked for this isolated offline-document test',
    compression: 'local static server sends Brotli when the browser accepts it',
    screenshot: 'chromium-' + engine + '.png' };
  fs.writeFileSync(dir + '/browser-' + engine + '.json', JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ engine, pass: true, requests: assets.length,
    localReload: engine === 'control' ? 'not applicable' : 'PASS', cdpBytes: output.initialCdpEncodedBytes }));
} catch(error) {
  fs.writeFileSync(dir + '/browser-' + engine + '.json', JSON.stringify({
    engine, pass: false, error: String(error?.stack ?? error), pageErrors, failedRequests, assets
  }, null, 2) + '\n');
  throw error;
} finally { await browser.close(); }
