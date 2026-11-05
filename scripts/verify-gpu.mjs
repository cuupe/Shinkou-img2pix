import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hardware integration check; deliberately fails rather than silently testing software.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configFile: false, cacheDir: 'node_modules/.vite-gpu-check', logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true }
    : { ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/illustration.png`);
  const report = await page.evaluate(async () => {
    const { WebGpuAccelerator } = await import('/src/engine/webgpu.ts');
    const { executeCpuStep, pixelate } = await import('/src/engine/pixelate.ts');
    const { pixelateAccelerated } = await import('/src/engine/backend.ts');
    const { DEFAULT_SETTINGS } = await import('/src/engine/types.ts');
    const gpu = await WebGpuAccelerator.create(), settings = { ...DEFAULT_SETTINGS, backend: 'gpu' };
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const difference = (a, b) => {
      check(a.length === b.length, 'Buffer lengths differ');
      let maximum = 0, changed = 0;
      for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); maximum = Math.max(maximum, d); if (d) changed++; }
      return { maximum, changed, total: a.length };
    };
    let seed = 12345;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; };
    const source = { width: 37, height: 29, data: Uint8ClampedArray.from({ length: 37 * 29 * 4 }, random) };
    const precision = [];
    for (const transparent of [true, false]) for (const detail of [true, false]) {
      const step = { kind: 'prepare', source, width: 17, height: 13, withFeatures: true, settings: { ...settings, detail, transparent, contrast: 13, brightness: -7, saturation: 24 } };
      const cpu = executeCpuStep(step), actual = await gpu.execute(step), rgba = difference(cpu.data, actual.data);
      check(rgba.maximum <= 1, `RGBA precision exceeded: ${JSON.stringify(rgba)}`);
      for (let i = 3; i < cpu.data.length; i += 4) check(cpu.data[i] === actual.data[i], 'Alpha coverage differs');
      const featureError = {};
      for (const field of ['importance', 'luminance', 'coherence']) {
        featureError[field] = difference(cpu.features[field], actual.features[field]).maximum;
        check(featureError[field] < 2e-5, `Feature ${field} differs: ${featureError[field]}`);
      }
      precision.push({ transparent, detail, rgba, featureError });
    }
    const palette = [[0, 0, 0], [255, 255, 255], [255, 40, 80], [12, 100, 220], [70, 180, 40], [90, 60, 180]];
    for (const dither of ['none', 'ordered', 'floyd']) {
      const original = { ...source, data: source.data.slice() };
      for (let i = 3; i < original.data.length; i += 4) original.data[i] = original.data[i] >= 128 ? 255 : 0;
      const step = { kind: 'quantize', ...original, palette, settings: { ...settings, dither } };
      const cpu = { ...step, data: step.data.slice() }, actual = { ...step, data: step.data.slice() };
      executeCpuStep(cpu); await gpu.execute(actual);
      check(difference(cpu.data, actual.data).maximum === 0, `${dither} quantization differs`);
    }
    const blob = await (await fetch('/illustration.png')).blob(), bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const illustration = { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
    const benchmarks = [];
    for (const size of [128, 256, 512]) {
      const parameters = { ...settings, size }, cpuRuns = [], gpuRuns = [];
      // One warm-up per backend, then three complete pipeline runs including readback.
      pixelate(illustration, parameters); await pixelateAccelerated(illustration, parameters, async () => gpu);
      let cpu, actual;
      for (let i = 0; i < 3; i++) {
        cpu = pixelate(illustration, parameters); cpuRuns.push(cpu.duration);
        actual = await pixelateAccelerated(illustration, parameters, async () => gpu); gpuRuns.push(actual.duration);
      }
      check(actual.execution.backend === 'gpu', actual.execution.reason || 'GPU was not used');
      const delta = difference(cpu.data, actual.data);
      let squared = 0, alphaDifferences = 0;
      for (let i = 0; i < cpu.data.length; i++) {
        if (i % 4 === 3) alphaDifferences += +(cpu.data[i] !== actual.data[i]);
        else squared += (cpu.data[i] - actual.data[i]) ** 2;
      }
      const psnr = squared ? 10 * Math.log10(255 ** 2 / (squared / (cpu.width * cpu.height * 3))) : null;
      check(!alphaDifferences && (psnr === null || psnr > 38), `End-to-end image differs excessively at ${size}px: ${psnr}dB`);
      const median = values => [...values].sort((a, b) => a - b)[1];
      benchmarks.push({ size, cpuMs: median(cpuRuns), gpuMs: median(gpuRuns), cpuRuns, gpuRuns, psnr, delta, execution: actual.execution });
    }
    // An unavailable device must retry the CPU path and preserve its exact output.
    const parameters = { ...settings, size: 32 }, expected = pixelate(source, parameters);
    const fallback = await pixelateAccelerated(source, parameters, async () => { throw new Error('Unavailable test device'); });
    check(fallback.execution.backend === 'cpu' && difference(expected.data, fallback.data).maximum === 0, 'CPU fallback failed');
    // Exercise asynchronous worker coalescing and thumbnail batches with the real backend.
    const worker = new Worker(new URL('/src/engine/pixel.worker.ts', location.origin), { type: 'module' });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worker queue timeout')), 30000), received = [];
      worker.onmessage = ({ data }) => {
        if (data.error) { clearTimeout(timeout); reject(new Error(data.error)); return; }
        received.push(data.id);
        if (data.id === 4) { clearTimeout(timeout); check(received.includes(3) && data.result.width === 32, 'Worker requests lost or reordered'); resolve(); }
      };
      worker.postMessage({ id: 1, source: illustration, settings: { ...settings, size: 64 } });
      worker.postMessage({ id: 2, settings: { ...settings, size: 128 } });
      worker.postMessage({ id: 3, keepAll: true, settings: { ...settings, size: 48 } });
      worker.postMessage({ id: 4, settings: parameters });
    }); worker.terminate();
    return { device: gpu.deviceName, precision, benchmarks, fallback: fallback.execution, workerQueue: 'passed' };
  });
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await server.close(); }
