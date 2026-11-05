import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, cacheDir: 'node_modules/.vite-ai-check', logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
try {
 await server.listen();
 browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true } : { ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
 const page = await browser.newPage();
 page.on('console', message => { if (message.text().startsWith('[AI QA]') || message.type() === 'error') console.error(message.text().slice(0, 700)); });
 page.on('requestfailed', request => console.error(`Request failed: ${request.url()} ${request.failure()?.errorText}`));
 page.setDefaultTimeout(120000);
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/illustration.png`);
 const report = await page.evaluate(async () => {
   const { analyzeEdges } = await import('/src/engine/ai-runtime.ts');
   const { pixelateAccelerated } = await import('/src/engine/backend.ts');
   const { DEFAULT_SETTINGS } = await import('/src/engine/types.ts');
   const check = (condition, message) => { if (!condition) throw new Error(message); };
   const image = await createImageBitmap(await (await fetch('/illustration.png')).blob());
   const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
   const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0); image.close();
   const source = { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
   console.log('[AI QA] CPU inference');
   const cpu = await analyzeEdges(source, true), cached = await analyzeEdges(source, true);
   const warmCpu = await analyzeEdges({ ...source }, true);
   check(cpu.info.backend === 'wasm' && cached.info.cached && cached.map === cpu.map, 'CPU inference/cache did not work');
   let minimum = 1, maximum = 0, sum = 0;
   for (const v of cpu.map.data) { minimum = Math.min(minimum, v); maximum = Math.max(maximum, v); sum += v; }
   check(maximum - minimum > .5, 'Model output is flat');
   console.log('[AI QA] WebGPU inference');
   let submissions = 0;
   const originalSubmit = GPUQueue.prototype.submit;
   GPUQueue.prototype.submit = function (...args) { submissions++; return originalSubmit.apply(this, args); };
   const gpu = await analyzeEdges(source, false);
   GPUQueue.prototype.submit = originalSubmit;
   check(gpu.info.backend === 'webgpu', gpu.info.reason || 'No hardware inference');
   check(submissions > 0, 'GPU provider did not submit any hardware work');
   let maxError = 0, squared = 0;
   for (let i = 0; i < cpu.map.data.length; i++) { const d = Math.abs(cpu.map.data[i] - gpu.map.data[i]); maxError = Math.max(maxError, d); squared += d * d; }
   check(Math.sqrt(squared / cpu.map.data.length) < .002, 'AI CPU/GPU predictions differ excessively');
   const settings = { ...DEFAULT_SETTINGS, backend: 'gpu', size: 128 };
   console.log('[AI QA] Conversion');
   const base = await pixelateAccelerated(source, settings), enhanced = await pixelateAccelerated(source, { ...settings, aiStrength: 75 });
   check(enhanced.execution.ai?.backend === 'webgpu', 'AI was not used by conversion');
   check(enhanced.width === base.width && enhanced.height === base.height && enhanced.palette.length <= settings.colors, 'AI changed dimensions or color budget');
   check(JSON.stringify(enhanced.palette) === JSON.stringify(base.palette), 'AI modified the extracted palette');
   const allowed = new Set(enhanced.palette.map(c => c.join(',')));
   let changed = 0;
   for (let p = 0; p < enhanced.width * enhanced.height; p++) {
     const i = p * 4; check(enhanced.data[i + 3] === base.data[i + 3], 'AI changed alpha');
     if (enhanced.data[i + 3]) check(allowed.has(Array.from(enhanced.data.slice(i, i + 3)).join(',')), 'Output has colors outside palette');
     if (enhanced.data[i] !== base.data[i] || enhanced.data[i + 1] !== base.data[i + 1] || enhanced.data[i + 2] !== base.data[i + 2]) changed++;
   }
   check(changed > 0 && changed < enhanced.width * enhanced.height / 2, 'AI effect is absent or unexpectedly broad');
   // Corrupt/missing model must be visible as failed AI, with intact base output.
   const failure = await pixelateAccelerated(source, { ...settings, aiStrength: 75 }, undefined, async () => { throw new Error('Unavailable model fixture'); });
   check(failure.execution.ai?.backend === 'none' && failure.execution.ai.reason.includes('Unavailable model fixture'), 'AI failure was not reported');
   check(failure.data.every((v, i) => v === base.data[i]), 'AI failure did not preserve reference conversion');
   return { model: cpu.info.model, device: gpu.info.device, response: { minimum, maximum, mean: sum / cpu.map.data.length }, cpuColdMs: cpu.info.duration, cpuWarmMs: warmCpu.info.duration, gpuMs: gpu.info.duration, gpuSubmissions: submissions, cachedMs: cached.info.duration, maxError, rmsError: Math.sqrt(squared / cpu.map.data.length), changedPixels: changed, totalPixels: enhanced.width * enhanced.height, conversionMs: enhanced.duration, fallback: failure.execution.ai.reason };
 });
 console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await server.close(); }
