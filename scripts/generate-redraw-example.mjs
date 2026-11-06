import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { chromium } from '@playwright/test';

// Render recorded, unretouched program outputs. This script does not run or
// simulate the generative model; its exact request is in redraw-example.json.
const size = Number(process.argv[2] ?? 32);
if (![16, 32].includes(size)) throw new Error('Recorded examples are available for 16 and 32 pixels');
const files = ['public/illustration.png', `docs/images/redraw-algorithm-${size}.png`, `docs/images/redraw-grid-${size}.png`];
const buffers = await Promise.all(files.map(file => fs.readFile(file)));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async ({ inputs, size }) => {
    const canvas = document.createElement('canvas'); canvas.width = 984; canvas.height = 392;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#1b1d21'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#edf0f3'; ctx.font = '600 20px "Microsoft YaHei", sans-serif'; ctx.fillText(`${size} px 实际输出对比`, 22, 33);
    const labels = ['参考原图', `基础算法 · ${size} × ${size}`, `AI 紧凑重绘 · ${size} × ${size}`];
    let count = 0;
    for (let index = 0; index < inputs.length; index++) {
      const image = new Image(); image.src = inputs[index]; await image.decode();
      const x = 22 + index * 326; ctx.imageSmoothingEnabled = index === 0;
      ctx.drawImage(image, x, 53, 288, 288); ctx.fillStyle = '#c3c9d0'; ctx.font = '13px "Microsoft YaHei", sans-serif'; ctx.fillText(labels[index], x, 367);
      if (index === 2) {
        if (image.width !== size || image.height !== size) throw new Error('Recorded grid must match the requested native size');
        const native = document.createElement('canvas'); native.width = size; native.height = size;
        const n = native.getContext('2d'); n.drawImage(image, 0, 0); const data = n.getImageData(0, 0, size, size).data;
        const colors = new Set(); for (let i = 0; i < data.length; i += 4) if (data[i + 3]) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
        count = colors.size;
      }
    }
    return { png: canvas.toDataURL(), count };
  }, { inputs: buffers.map(buffer => `data:image/png;base64,${buffer.toString('base64')}`), size });
  await fs.writeFile(`docs/images/generative-redraw-${size}.png`, Buffer.from(result.png.split(',')[1], 'base64'));
  const recipeFile = size === 32 ? 'docs/redraw-example.json' : 'docs/redraw-example-16.json';
  const recipe = JSON.parse(await fs.readFile(recipeFile, 'utf8'));
  if (result.count > recipe.grid.colors) throw new Error('Recorded output exceeds its palette budget');
  recipe.source = { path: files[0], sha256: crypto.createHash('sha256').update(buffers[0]).digest('hex') };
  recipe.recorded = { date: '2026-11-06', generated: `docs/images/redraw-generated-${size * 4}.png`, output: files[2], actualColors: result.count, phaseX: 0, phaseY: 0 };
  await fs.writeFile(recipeFile, `${JSON.stringify(recipe, null, 2)}\n`);
  console.log(`Recorded ${size}x${size} candidate: ${result.count} colors; comparison rendered.`);
} finally { await browser.close(); }
