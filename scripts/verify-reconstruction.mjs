import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, cacheDir: 'node_modules/.vite-reconstruction-check', logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true } : { ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/illustration.png`);
  const report = await page.evaluate(async () => {
    const { analyzeSemantics } = await import('/src/engine/semantic-runtime.ts');
    const { pixelateAccelerated } = await import('/src/engine/backend.ts');
    const { DEFAULT_SETTINGS } = await import('/src/engine/types.ts');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const image = await createImageBitmap(await (await fetch('/illustration.png')).blob());
    const c = new OffscreenCanvas(image.width, image.height), ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0); image.close();
    const source = { width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
    const cpu = await analyzeSemantics(source, true);
    check(cpu.info.backend === 'wasm' && cpu.faces.length === 1, 'Real CPU landmark inference failed');
    check(cpu.faces[0].highlights.length === 2, 'The original eye highlights were not found');
    let submissions = 0;
    const originalSubmit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (...args) { submissions++; return originalSubmit.apply(this, args); };
    let gpu;
    try { gpu = await analyzeSemantics(source, false); } finally { GPUQueue.prototype.submit = originalSubmit; }
    check(gpu.info.backend === 'webgpu' && submissions > 0 && gpu.faces.length === 1, 'No real hardware GPU inference');
    let maxError = 0;
    cpu.faces[0].points.forEach((p, i) => p.forEach((v, k) => { maxError = Math.max(maxError, Math.abs(v - gpu.faces[0].points[i][k])); }));
    check(maxError < .005, `CPU/GPU landmark mismatch: ${maxError}`);
    const sizes = [];
    for (const size of [32, 48, 64]) {
      const settings = { ...DEFAULT_SETTINGS, size, backend: 'cpu' };
      const result = await pixelateAccelerated(source, settings);
      check(result.execution.semantic?.faces === 1 && result.execution.timings.reconstruction >= 0, 'The model was not integrated into the conversion');
      check(result.palette.length <= settings.colors, 'Color budget exceeded');
      for (const [x, y] of cpu.faces[0].highlights) {
        const p = (Math.floor(y * result.height) * result.width + Math.floor(x * result.width)) * 4;
        check(Math.min(result.data[p], result.data[p + 1], result.data[p + 2]) > 230, `${size}px eye highlight was lost`);
      }
      const without = await pixelateAccelerated(source, { ...settings, semanticDetail: 0 });
      let changed = 0;
      for (let p = 0; p < result.width * result.height; p++) if ([0, 1, 2].some(k => result.data[p * 4 + k] !== without.data[p * 4 + k])) changed++;
      check(changed > 0, 'Neural analysis had no effect on the final pixels');
      sizes.push({ size, milliseconds: result.duration, changedPixelsWithSemantics: changed });
    }
    const a = await pixelateAccelerated(source, { ...DEFAULT_SETTINGS, backend: 'cpu', size: 160 });
    const b = await pixelateAccelerated(source, { ...DEFAULT_SETTINGS, backend: 'cpu', size: 160, lowResolution: 'source' });
    check(a.data.every((v, i) => v === b.data[i]) && !a.execution.semantic, '160px behavior changed');
    return { model: cpu.info.model, cpuMilliseconds: cpu.info.duration, gpuMilliseconds: gpu.info.duration, device: gpu.info.device, gpuSubmissions: submissions, maxLandmarkError: maxError, sizes, unchanged160: true };
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally { await browser?.close(); await server.close(); }
