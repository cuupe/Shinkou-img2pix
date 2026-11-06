// Reproducible visual review of a low-resolution engine change.
// Baselines are captured before edits; no external inference or image uploads.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve('.'), output = resolve('.cache/upgrade-09');
const phase = process.argv.includes('--before') ? 'before' : 'after';
await mkdir(output,{recursive:true});
const files={illustration:'public/illustration.png',landscape:'public/lighthouse.png'};
const pony=process.argv.indexOf('--pony');if(pony>=0)files.pony=process.argv[pony+1];
const server=await createServer({root,configFile:false,logLevel:'error',resolve:{conditions:['onnxruntime-web-use-extern-wasm','module','browser','development|production']},optimizeDeps:{noDiscovery:true,entries:[]},server:{host:'127.0.0.1',port:0,watch:{ignored:['**/.cache/**']}}});let browser;
try{
 await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();page.setDefaultTimeout(120000);await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/illustration.png`);
 for(const[name,file]of Object.entries(files)){
  const bytes=(await readFile(resolve(file))).toString('base64');
  const before={};if(phase==='after')for(const size of[64,48,32,160])before[size]=(await readFile(join(output,`${name}-before-${size}.png`))).toString('base64');
  const result=await page.evaluate(async({name,bytes,before,phase})=>{
   const{pixelateAccelerated}=await import('/src/engine/backend.ts');const{DEFAULT_SETTINGS}=await import('/src/engine/types.ts');const{analyzeSemantics}=await import('/src/engine/semantic-runtime.ts');
   const make=(w,h)=>Object.assign(document.createElement('canvas'),{width:w,height:h});
   const decode=async b=>{const im=await createImageBitmap(new Blob([Uint8Array.from(atob(b),c=>c.charCodeAt(0))]));const c=make(im.width,im.height);c.getContext('2d').drawImage(im,0,0);im.close();return c};
   const original=await decode(bytes),source={width:original.width,height:original.height,data:original.getContext('2d').getImageData(0,0,original.width,original.height).data};
   const semantics=await analyzeSemantics(source,true),assets={},records=[],rows=[];const save=(n,c)=>assets[n]=c.toDataURL('image/png').split(',')[1];
   for(const size of[64,48,32,160]){
    const result=await pixelateAccelerated(source,{...DEFAULT_SETTINGS,backend:'cpu',size});const c=make(result.width,result.height);c.getContext('2d').putImageData(new ImageData(result.data,result.width,result.height),0,0);save(`${name}-${phase}-${size}.png`,c);
    if(phase==='after'){
      const old=await decode(before[size]),expected=old.getContext('2d').getImageData(0,0,old.width,old.height).data;
      const legacy=size===160?result:await pixelateAccelerated(source,{...DEFAULT_SETTINGS,backend:'cpu',size,pixelClarity:0});
      if(legacy.data.length!==expected.length||!legacy.data.every((v,i)=>v===expected[i]))throw Error(`${name}/${size}: legacy or 160px regression`);
    }
    records.push({size,width:c.width,height:c.height,palette:result.palette,execution:result.execution,duration:result.duration});if(phase==='after'&&size!==160)rows.push([original,await decode(before[size]),c]);
    if(phase==='before'&&size===64){const r=await pixelateAccelerated(source,{...DEFAULT_SETTINGS,backend:'cpu',size,outlineRetention:100});const b=make(r.width,r.height);b.getContext('2d').putImageData(new ImageData(r.data,r.width,r.height),0,0);save(`${name}-before-outline100.png`,b);}
   }
   if(rows.length){const fig=make(1232,1450),ctx=fig.getContext('2d');ctx.fillStyle='#15181c';ctx.fillRect(0,0,fig.width,fig.height);rows.forEach((items,row)=>items.forEach((c,col)=>{const sc=col?Math.floor(384/Math.max(c.width,c.height)):384/Math.max(c.width,c.height),w=c.width*sc,h=c.height*sc;ctx.imageSmoothingEnabled=col===0;ctx.drawImage(c,16+col*408+(384-w)/2,24+row*476+(384-h)/2,w,h);ctx.fillStyle='#e8edf4';ctx.font='18px Microsoft YaHei';ctx.fillText(col===0?'Source':`${col===1?'0.8 before':'Candidate'} / ${c.width}x${c.height}`,16+col*408,24+row*476+414)}));save(`${name}-comparison.png`,fig);}
   return{assets,records,semantics};
  },{name,bytes,before,phase});
  for(const[n,b]of Object.entries(result.assets))await writeFile(join(output,n),Buffer.from(b,'base64'));
  await writeFile(join(output,`${name}-${phase}.json`),JSON.stringify({input:file,records:result.records,semantics:result.semantics},null,2));console.log(name,phase,result.records.map(r=>({size:r.size,ms:Math.round(r.duration)})));
 }
}finally{await browser?.close();await server.close();}
