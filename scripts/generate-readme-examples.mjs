import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'docs', 'images');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await mkdir(output, { recursive: true });

const server = await createServer({
  root, configFile: false, cacheDir: 'node_modules/.vite-docs-examples', logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true }
    : { ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
  const page = await browser.newPage();
  await page.goto(`${base}/illustration.png`);
  const generated = await page.evaluate(async () => {
    const { pixelate } = await import('/src/engine/pixelate.ts');
    const { DEFAULT_SETTINGS } = await import('/src/engine/types.ts');
    const assets = {}, records = [];
    const toCanvas = result => {
      const canvas = document.createElement('canvas');
      canvas.width = result.width; canvas.height = result.height;
      canvas.getContext('2d').putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
      return canvas;
    };
    const input = async name => {
      const response = await fetch(`/${name}`);
      if (!response.ok) throw new Error(`Cannot load ${name}`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0); bitmap.close();
      return { canvas, data: context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
    };
    const convert = (source, sourceName, filename, patch) => {
      const settings = { ...DEFAULT_SETTINGS, ...patch, backend: 'cpu' };
      const result = pixelate(source, settings), canvas = toCanvas(result);
      // Native-resolution output, suitable for inspection or reuse as a fixture.
      assets[filename] = canvas.toDataURL('image/png').split(',')[1];
      records.push({ source: sourceName, output: `docs/images/${filename}`, width: result.width, height: result.height, paletteColors: result.palette.length, settings });
      return canvas;
    };
    const comparison = (filename, title, panels, caption) => {
      const gutter = 32, gap = 24, panelWidth = 512;
      const panelHeight = Math.max(...panels.map(p => Math.round(p.canvas.height / p.canvas.width * panelWidth)));
      const figure = document.createElement('canvas');
      figure.width = gutter * 2 + panels.length * panelWidth + (panels.length - 1) * gap;
      figure.height = panelHeight + 182;
      const context = figure.getContext('2d');
      context.fillStyle = '#171a1e'; context.fillRect(0, 0, figure.width, figure.height);
      context.font = '600 25px "Segoe UI", "Microsoft YaHei", sans-serif';
      context.fillStyle = '#eff3f7'; context.fillText(title, gutter, 43);
      panels.forEach((panel, index) => {
        const x = gutter + index * (panelWidth + gap);
        const height = Math.round(panel.canvas.height / panel.canvas.width * panelWidth);
        context.imageSmoothingEnabled = panel.original === true;
        if (panel.original) context.imageSmoothingQuality = 'high';
        context.drawImage(panel.canvas, x, 72, panelWidth, height);
        context.fillStyle = panel.original ? '#d2d9e2' : '#c4ed91';
        context.font = '20px "Segoe UI", "Microsoft YaHei", sans-serif';
        context.fillText(panel.label, x, panelHeight + 109);
      });
      context.fillStyle = '#9ca8b7';
      context.font = '15px "Segoe UI", "Microsoft YaHei", sans-serif';
      context.fillText(caption, gutter, panelHeight + 151);
      assets[filename] = figure.toDataURL('image/png').split(',')[1];
    };

    const illustration = await input('illustration.png');
    const illustration128 = convert(illustration, 'public/illustration.png', 'illustration-128.png', { size: 128 });
    const illustration256 = convert(illustration, 'public/illustration.png', 'illustration-256.png', { size: 256 });
    comparison('illustration-comparison.png', '插画转换示例', [
      { canvas: illustration.canvas, label: `原图 · ${illustration.width} × ${illustration.height}`, original: true },
      { canvas: illustration128, label: '结构保真 · 128 × 128' },
      { canvas: illustration256, label: '结构保真 · 256 × 256' },
    ], '自适应 32 色 · 过渡色保留 25 · 线条保护 75 · 轮廓规整 65 · 碎点合并 45');

    const retain0 = convert(illustration, 'public/illustration.png', 'illustration-retention-0.png', { size: 128, transitionRetention: 0 });
    const retain100 = convert(illustration, 'public/illustration.png', 'illustration-retention-100.png', { size: 128, transitionRetention: 100 });
    comparison('transition-comparison.png', '过渡色保留对比', [
      { canvas: retain0, label: '0 · 优先主体色' },
      { canvas: illustration128, label: '25 · 默认值' },
      { canvas: retain100, label: '100 · 关闭过渡归并' },
    ], '相同原图、128 × 128、32 色；仅改变过渡色保留，其余参数一致。');

    const landscape = await input('lighthouse.png');
    const landscape128 = convert(landscape, 'public/lighthouse.png', 'landscape-128.png', { method: 'sample', size: 128, dither: 'floyd', ditherAmount: 35 });
    comparison('landscape-comparison.png', '风景转换示例', [
      { canvas: landscape.canvas, label: `原图 · ${landscape.width} × ${landscape.height}`, original: true },
      { canvas: landscape128, label: `照片采样 · ${landscape128.width} × ${landscape128.height}` },
    ], '自适应 32 色 · Floyd–Steinberg 误差扩散 · 抖动强度 35 · 细节增强开启');
    return { assets, records };
  });

  for (const [name, base64] of Object.entries(generated.assets)) {
    await writeFile(join(output, name), Buffer.from(base64, 'base64'));
  }
  const sourceNames = [...new Set(generated.records.map(record => record.source))];
  const sources = await Promise.all(sourceNames.map(async source => ({
    path: source,
    sha256: createHash('sha256').update(await readFile(join(root, source))).digest('hex'),
    provenance: 'AI-generated demonstration input bundled with the project',
  })));
  await writeFile(join(root, 'docs', 'examples.json'), JSON.stringify({
    schemaVersion: 1, appVersion: version, sources, examples: generated.records,
    presentation: 'Outputs are unmodified algorithm results; comparison panels use integer nearest-neighbor enlargement. Source panels are resized for display.',
  }, null, 2) + '\n');
  process.stdout.write(`Generated ${Object.keys(generated.assets).length} PNG files and docs/examples.json\n`);
} finally {
  await browser?.close();
  await server.close();
}
