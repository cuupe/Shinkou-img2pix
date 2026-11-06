import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { chromium } from '@playwright/test';

// Reprocess the same recorded model outputs: no new inference or image edits.
// Start the local Vite preview before running this script.
const files = ['public/illustration.png', 'docs/images/redraw-generated-128.png', 'docs/images/redraw-generated-64.png'];
const buffers = await Promise.all(files.map(file => fs.readFile(file)));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage(); await page.goto('http://127.0.0.1:1420');
  const results = await page.evaluate(async inputs => {
    const { prepareRedrawColors } = await import('/src/engine/redraw-colors.ts');
    const { normalizeRedraw } = await import('/src/engine/redraw.ts');
    const images = [];
    for (const input of inputs) {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(input), c => c.charCodeAt(0))]));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
      images.push({ canvas, source: { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data } });
    }
    const reference = prepareRedrawColors(images[0].source, 32), outputs = [];
    for (const [index, size] of [[1, 32], [2, 16]]) {
      const grids = [];
      for (const colorRetention of [0, 100]) {
        const result = normalizeRedraw(images[index].source, { size, colors: 32, palette: 'adaptive', phaseX: 0, phaseY: 0, sourceColors: reference, colorRetention });
        const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
        canvas.getContext('2d').putImageData(new ImageData(result.data, size, size), 0, 0);
        grids.push({ canvas, colors: result.palette.length, png: canvas.toDataURL() });
      }
      const canvas = document.createElement('canvas'); canvas.width = 984; canvas.height = 392;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#1b1d21'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#edf0f3'; ctx.font = '600 20px "Microsoft YaHei", sans-serif'; ctx.fillText(`${size} px 原图配色约束 · 同一模型输出`, 22, 33);
      const labels = ['参考原图', '保留 0% · 模型配色', '保留 100% · 原图色板'];
      for (let n = 0; n < 3; n++) {
        ctx.imageSmoothingEnabled = n === 0;
        ctx.drawImage(n === 0 ? images[0].canvas : grids[n - 1].canvas, 22 + 326 * n, 53, 288, 288);
        ctx.fillStyle = '#c3c9d0'; ctx.font = '13px "Microsoft YaHei", sans-serif'; ctx.fillText(labels[n], 22 + 326 * n, 367);
      }
      outputs.push({ size, before: grids[0].png, after: grids[1].png, colors: grids[1].colors, comparison: canvas.toDataURL() });
    }
    return { palette: reference.palette, outputs };
  }, buffers.map(b => b.toString('base64')));
  const outputs = [];
  for (const output of results.outputs) {
    const after = `docs/images/redraw-source-colors-${output.size}.png`, comparison = `docs/images/redraw-colors-${output.size}.png`;
    await fs.writeFile(after, Buffer.from(output.after.split(',')[1], 'base64'));
    await fs.writeFile(comparison, Buffer.from(output.comparison.split(',')[1], 'base64'));
    outputs.push({ size: output.size, raw: files[output.size === 32 ? 1 : 2], rawSha256: crypto.createHash('sha256').update(buffers[output.size === 32 ? 1 : 2]).digest('hex'), before: `docs/images/redraw-grid-${output.size}.png`, after, comparison, colors: output.colors, colorRetention: 100 });
  }
  await fs.writeFile('docs/redraw-colors-example.json', `${JSON.stringify({ version: '0.10.1', source: files[0], sourceSha256: crypto.createHash('sha256').update(buffers[0]).digest('hex'), palette: results.palette, outputs }, null, 2)}\n`);
  console.log('Rendered source-color comparisons from unchanged recorded model outputs.');
} finally { await browser.close(); }
