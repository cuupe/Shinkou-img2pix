// Generates comparison figures, not new illustration content. The reference
// images are generated separately with imagegen; this script only normalizes
// their resolution/palette and lays out the actual image buffers for review.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
const folder = dirname(fileURLToPath(import.meta.url)), root = resolve(folder, '../..');
const manifest = JSON.parse(await readFile(join(folder, 'current/manifest.json'), 'utf8'));
const prefix = '/' + folder.slice(root.length + 1).replaceAll('\\', '/');
const server = await createServer({ root, configFile: false, logLevel: 'error', optimizeDeps: { noDiscovery: true, entries: [] }, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.cache/**'] } } });
let browser;
try {
 await server.listen();
 browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
 const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/illustration.png`);
 const result = await page.evaluate(async ({ prefix, records }) => {
  const { executeCpuStep } = await import('/src/engine/pixelate.ts');
  const assets = {}, entries = [];
  const canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
  const load = async path => { const image = await createImageBitmap(await (await fetch(path)).blob()); const c = canvas(image.width, image.height); c.getContext('2d').drawImage(image, 0, 0); image.close(); return c; };
  const save = (name, c) => assets[name] = c.toDataURL('image/png').split(',')[1];
  const source = await load('/illustration.png'), rows = [];
  for (const size of [64, 32]) {
   const rawName = size === 32 ? 'ai-reference-32-v2-raw.png' : 'ai-reference-64-raw.png';
   const record = records.find(r => r.width === size), current = await load(`${prefix}/current/baseline-${size}.png`), raw = await load(`${prefix}/${rawName}`);
   const candidate = canvas(size, size), ctx = candidate.getContext('2d');
   ctx.imageSmoothingEnabled = false; ctx.drawImage(raw, 0, 0, size, size);
   const pixels = ctx.getImageData(0, 0, size, size).data;
   executeCpuStep({ kind: 'quantize', data: pixels, width: size, height: size, palette: record.baseline.palette, settings: { ...record.settings, dither: 'none' } });
   ctx.putImageData(new ImageData(pixels, size, size), 0, 0);
   const countColors = c => { const a = c.getContext('2d').getImageData(0,0,c.width,c.height).data, colors = new Set(); for(let p=0;p<a.length;p+=4)if(a[p+3])colors.add(`${a[p]},${a[p+1]},${a[p+2]}`);return colors.size; };
   const allowed = new Set(record.baseline.palette.map(c => c.join(',')));
   for(let p=0;p<pixels.length;p+=4)if(pixels[p+3] && !allowed.has(`${pixels[p]},${pixels[p+1]},${pixels[p+2]}`))throw new Error('Reference palette mismatch');
   save(`ai-reference-${size}-grid.png`, candidate);
   entries.push({ size, rawSize: [raw.width, raw.height], gridSize: [size,size], baselineColors: countColors(current), referenceColors: countColors(candidate), palette: record.baseline.palette, normalization: 'Browser canvas nearest-neighbor resampling, then the application Oklab nearest-color quantizer with the exact baseline palette; no dithering or structural postprocessing.', source: rawName, nativeReference: `ai-reference-${size}-grid.png` });
   rows.push({ size, current, candidate });
  }
  const drawImage = (ctx, c, x, y, w, smooth = false) => { ctx.imageSmoothingEnabled = smooth; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(c,x,y,w,w); };
  const text = (ctx, s, x, y, font = '18px "Microsoft YaHei", sans-serif', color='#c9d2df') => { ctx.font=font;ctx.fillStyle=color;ctx.fillText(s,x,y); };
  const panel=384,gap=24,margin=32, rowH=488, fig=canvas(margin*2+panel*3+gap*2,120+rowH*2+60), ctx=fig.getContext('2d');
  ctx.fillStyle='#14171b';ctx.fillRect(0,0,fig.width,fig.height);
  text(ctx,'低分辨率视觉目标｜实际 v0.8.0 与 AI 参考',margin,44,'600 27px "Microsoft YaHei", sans-serif','#eff3f7');
  text(ctx,'同一角色与近似构图 · 相同目标网格 · 参考使用当前输出的同一色板',margin,78);
  rows.forEach((r,i)=>{const y=112+i*rowH;[source,r.current,r.candidate].forEach((c,j)=>drawImage(ctx,c,margin+j*(panel+gap),y,panel,j===0));
   text(ctx,'原图',margin,y+414);text(ctx,`${r.size} × ${r.size} · 软件实际输出`,margin+panel+gap,y+414,'600 18px "Microsoft YaHei", sans-serif','#d1e7a3');
   text(ctx,`${r.size} × ${r.size} · AI 参考落格`,margin+2*(panel+gap),y+414,'600 18px "Microsoft YaHei", sans-serif','#eac69d');
   text(ctx,`右侧为设计目标；不是已实现的转换效果。${panel/r.size} 倍最近邻展示。`,margin,y+449,'15px "Microsoft YaHei", sans-serif');
  });
  text(ctx,'AI 参考有造型改写，不能视为逐像素真值或成熟模型效果；原始生成图及完整处理记录一并保留。',margin,fig.height-24,'15px "Microsoft YaHei", sans-serif');save('comparison.png',fig);
  // Same-position source crops: show eye/mouth/hair relationships at identical
  // physical scale. No retouching or generative changes are applied here.
  for(const r of rows){const crop={x:Math.floor(r.size*.25),y:Math.floor(r.size*.28),w:Math.ceil(r.size*.5),h:Math.ceil(r.size*.42)}, scale=r.size===32?24:12;
   const cw=crop.w*scale,ch=crop.h*scale,c=canvas(64+cw*2+24,ch+132),g=c.getContext('2d');g.fillStyle='#14171b';g.fillRect(0,0,c.width,c.height);
   text(g,`${r.size} × ${r.size}｜相同位置的五官局部`,32,34,'600 24px "Microsoft YaHei", sans-serif','#eff3f7');
   [r.current,r.candidate].forEach((input,i)=>{g.imageSmoothingEnabled=false;g.drawImage(input,crop.x,crop.y,crop.w,crop.h,32+i*(cw+24),58,cw,ch);text(g,i?'AI 参考落格 · 同色板':'软件当前输出',32+i*(cw+24),ch+94);});save(`face-${r.size}-comparison.png`,c);
  }
  return { assets, entries };
 }, { prefix, records: manifest.records });
 for(const[name,base64]of Object.entries(result.assets))await writeFile(join(folder,name),Buffer.from(base64,'base64'));
 const hashes = {};
 for(const name of ['ai-reference-32-raw.png','ai-reference-32-v2-raw.png','ai-reference-64-raw.png',...Object.keys(result.assets)])hashes[name]=createHash('sha256').update(await readFile(join(folder,name))).digest('hex');
 await writeFile(join(folder,'reference-manifest.json'),JSON.stringify({ schemaVersion:1, appVersion:manifest.appVersion, baselineCommit:'e4875960663dd3374677d36cd2d8ebc6161772c0', source:{...manifest.source,path:'public/illustration.png'}, referenceProvenance:'Built-in imagegen with public/illustration.png as reference; the selected 32px concept is a second imagegen edit of the first normalized 32px reference to improve native-size legibility. Not an integrated application model or a native-grid prediction.', entries:result.entries, hashes },null,2)+'\n');
 console.log(JSON.stringify({output:folder,entries:result.entries.map(({palette,...r})=>r)},null,2));
} finally { await browser?.close(); await server.close(); }
