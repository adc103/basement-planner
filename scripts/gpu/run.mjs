// Bundle a browser check, run it in headless Chrome with WebGPU (SwiftShader), print the result.
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
const entry = process.argv[2];
const query = process.argv[3] ?? '';
const r = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', target: 'es2022' });
const js = r.outputFiles[0].text;
const server = http.createServer((req, res) => {
  if (process.env.DATA && req.url.startsWith('/data/')) { const f = process.env.DATA + '/' + req.url.slice(6).split('?')[0]; if (existsSync(f)) { res.end(readFileSync(f)); return; } res.statusCode = 404; res.end(); return; }
  if (req.url.startsWith('/app.js')) { res.setHeader('content-type', 'text/javascript'); res.end(js); return; }
  res.setHeader('content-type', 'text/html'); res.end('<!doctype html><script type="module" src="/app.js"></script>');
}).listen(0, '127.0.0.1');
await new Promise((ok) => server.once('listening', ok));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--no-proxy-server'] });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error('[page]', m.text()); });
await page.goto(`http://127.0.0.1:${port}/${query}`);
await page.waitForFunction(() => window.__result, null, { timeout: Number(process.env.TIMEOUT ?? 600000), polling: 500 });
const result = await page.evaluate(() => window.__result);
if (result.images && process.env.OUT) { const { writeFileSync } = await import('node:fs'); for (const [name, b64] of Object.entries(result.images)) writeFileSync(`${process.env.OUT}/${name}.png`, Buffer.from(b64.split(',')[1], 'base64')); delete result.images; }
console.log(JSON.stringify(result, null, 1));
await browser.close();
server.close();
