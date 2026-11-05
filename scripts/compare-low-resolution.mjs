import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

// Compare a model's native-resolution PNGs against the actual application.
// Candidate inference is external. The baseline runs the real app, including
// its bundled facial model when applicable. Nothing is uploaded or downloaded.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = { input: 'public/illustration.png', output: '.cache/low-resolution-comparison', label: 'Candidate' };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (!['input', 'output', 'candidate-dir', 'label'].includes(key) || !process.argv[i + 1]) {
    throw new Error('Usage: node scripts/compare-low-resolution.mjs [--input image.png] [--candidate-dir directory] [--output directory] [--label name]');
  }
  options[key] = process.argv[i + 1];
}
const sizes = [64, 48, 32];
const sha256 = data => createHash('sha256').update(data).digest('hex');
const inputPath = resolve(root, options.input), output = resolve(root, options.output);
const source = await readFile(inputPath);
const candidates = {};
for (const size of sizes) {
  if (!options['candidate-dir']) break;
  const path = resolve(root, options['candidate-dir'], `${size}.png`), bytes = await readFile(path);
  candidates[size] = { path, sha256: sha256(bytes), base64: bytes.toString('base64') };
}
const writtenNames = ['comparison.png', 'manifest.json', 'reference-160.png', ...sizes.flatMap(size => [`baseline-${size}.png`, `candidate-${size}.png`, `candidate-palette-${size}.png`])];
if ([inputPath, ...Object.values(candidates).map(c => c.path)].some(path => writtenNames.some(name => resolve(output, name) === path))) {
  throw new Error('Output would overwrite an input; choose a different --output directory');
}
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const server = await createServer({
  root, configFile: false, cacheDir: 'node_modules/.vite-low-resolution', logLevel: 'error',
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'] },
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.cache/**'] } },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true }
    : { ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/illustration.png`);
  const generated = await page.evaluate(async ({ sourceBase64, candidates, sizes, label }) => {
    const { executeCpuStep } = await import('/src/engine/pixelate.ts');
    const { pixelateAccelerated } = await import('/src/engine/backend.ts');
    const { DEFAULT_SETTINGS } = await import('/src/engine/types.ts');
    const canvas = (width, height, data) => {
      const c = document.createElement('canvas'); c.width = width; c.height = height;
      if (data) c.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
      return c;
    };
    const decode = async base64 => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes]));
      const c = canvas(image.width, image.height), context = c.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0); image.close();
      return { canvas: c, width: c.width, height: c.height, data: context.getImageData(0, 0, c.width, c.height).data };
    };
    const source = await decode(sourceBase64), assets = {}, records = [], rows = [];
    const save = (name, c) => { assets[name] = c.toDataURL('image/png').split(',')[1]; };
    const settings = { ...DEFAULT_SETTINGS, backend: 'cpu', aiStrength: 0 };
    for (const size of [...sizes, 160]) {
      const result = await pixelateAccelerated(source, { ...settings, size });
      const baseline = canvas(result.width, result.height, result.data);
      save(size === 160 ? 'reference-160.png' : `baseline-${size}.png`, baseline);
      const record = { width: result.width, height: result.height, settings: { ...settings, size }, baseline: { palette: result.palette, durationMs: result.duration, execution: result.execution } };
      if (size === 160) { records.push(record); continue; }
      const panels = [{ canvas: source.canvas, original: true, label: 'Source (display preview)' }, { canvas: baseline, label: `Current / ${result.width} x ${result.height}` }];
      if (candidates[size]) {
        const candidate = await decode(candidates[size].base64);
        if (candidate.width !== result.width || candidate.height !== result.height) {
          throw new Error(`${size}.png must be native ${result.width} x ${result.height}; got ${candidate.width} x ${candidate.height}. It will not be resized.`);
        }
        // Never run line protection, topology cleanup or smoothing on model output.
        // Keep the raw prediction; also compare with the exact baseline palette.
        const data = candidate.data.slice();
        if (!result.palette.length && data.some((v, i) => i % 4 === 3 && v > 0)) throw new Error('The source has no opaque palette; an opaque candidate cannot be remapped');
        const alpha = Array.from({ length: data.length / 4 }, (_, i) => data[i * 4 + 3]);
        if (alpha.some(a => a !== 0 && a !== 255)) throw new Error(`${size}.png contains partial alpha; supply a finalized pixel grid`);
        executeCpuStep({ kind: 'quantize', data, width: candidate.width, height: candidate.height, palette: result.palette, settings: { ...settings, dither: 'none' } });
        const quantized = canvas(candidate.width, candidate.height, data);
        save(`candidate-${size}.png`, candidate.canvas); save(`candidate-palette-${size}.png`, quantized);
        panels.push({ canvas: candidate.canvas, label: `${label} / raw` }, { canvas: quantized, label: `${label} / same palette` });
        record.candidate = { sha256: candidates[size].sha256, paletteRemap: 'Oklab nearest, exact baseline palette; no dithering or structural postprocessing' };
      }
      rows.push(panels); records.push(record);
    }
    const panel = 256, gap = 24, margin = 24, rowHeight = 320;
    const count = Math.max(...rows.map(row => row.length));
    const figure = canvas(margin * 2 + count * panel + (count - 1) * gap, margin * 2 + rows.length * rowHeight);
    const ctx = figure.getContext('2d'); ctx.fillStyle = '#171a1e'; ctx.fillRect(0, 0, figure.width, figure.height);
    rows.forEach((row, y) => row.forEach((item, x) => {
      const scale = item.original ? panel / Math.max(item.canvas.width, item.canvas.height) : Math.floor(panel / Math.max(item.canvas.width, item.canvas.height));
      const w = item.canvas.width * scale, h = item.canvas.height * scale;
      ctx.imageSmoothingEnabled = !!item.original; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(item.canvas, margin + x * (panel + gap) + (panel - w) / 2, margin + y * rowHeight + (panel - h) / 2, w, h);
      ctx.fillStyle = '#d2d9e2'; ctx.font = '14px Segoe UI, sans-serif';
      ctx.fillText(item.label, margin + x * (panel + gap), margin + y * rowHeight + panel + 24, panel);
      if (!item.original) ctx.fillText(`${scale}x nearest-neighbor display`, margin + x * (panel + gap), margin + y * rowHeight + panel + 44, panel);
    }));
    save('comparison.png', figure);
    return { assets, records };
  }, { sourceBase64: source.toString('base64'), candidates, sizes, label: options.label });
  await mkdir(output, { recursive: true });
  for (const [name, base64] of Object.entries(generated.assets)) await writeFile(join(output, name), Buffer.from(base64, 'base64'));
  await writeFile(join(output, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, appVersion: version, source: { path: inputPath, sha256: sha256(source) },
    candidateLabel: options.label, candidates: Object.fromEntries(Object.entries(candidates).map(([size, { base64: _, ...item }]) => [size, item])),
    records: generated.records, note: 'Visual comparison, not a perceptual quality score. Candidate model identity and training provenance are not verified by this tool.',
  }, null, 2) + '\n');
  process.stdout.write(`Saved ${Object.keys(generated.assets).length} PNGs and manifest.json to ${output}\n`);
} finally {
  await browser?.close();
  await server.close();
}
