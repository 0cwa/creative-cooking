import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname);
const server = createServer(async (req,res) => { try { const p=resolve(root,'.'+new URL(req.url,'http://localhost').pathname); if (!p.startsWith(root+sep)) throw Error('path'); const data=await readFile(p); res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.wasm':'application/wasm'})[extname(p)]||'application/octet-stream'); res.end(data); } catch { res.writeHead(404).end(); } });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try { browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH}); const page=await browser.newPage(); page.on('pageerror',e=>console.error(e)); await page.goto(`http://127.0.0.1:${server.address().port}/index.html`); await page.waitForFunction(()=>document.querySelector('#result').textContent!=='running'); const result=await page.locator('#result').innerText(); console.log(result); if (!result.startsWith('PASS:')) process.exitCode=1; } finally { await browser?.close(); server.close(); }
