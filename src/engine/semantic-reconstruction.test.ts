import { describe, it, expect } from 'vitest';
import { sourceEyeDetails, sourceEyeHighlights, sourceMouthDetail } from './semantic-features';
import { pixelateWithExecutor, executeCpuStep } from './pixelate';
import { reconstructClusters } from './pixel-clusters';
import { DEFAULT_SETTINGS } from './types';
import type { PixelSource, SemanticFace } from './types';

function faceFixture(open = false, monochrome = false): { source: PixelSource; face: SemanticFace } {
  const width = 256, height = 256, data = new Uint8ClampedArray(width * height * 4);
  const face: SemanticFace = { box: [.1,.15,.8,.7], points: Array.from({length:28},()=>[.5,.5,1] as [number,number,number]) };
  for (const [index,cx] of [[0,.28],[1,.72]]) {
    face.points.splice(11+index*6,6,[cx-.09,.34,1],[cx,.28,1],[cx+.09,.34,1],[cx-.09,.39,1],[cx,.44,1],[cx+.09,.39,1]);
  }
  face.points.splice(24,4,[.4,.65,1],[.5,.68,1],[.6,.65,1],[.5,.69,1]);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const nx=(x+.5)/width,ny=(y+.5)/height; let c=[240,200,180,255];
    for(const cx of [.28,.72]) {
      const d=((nx-cx)/.09)**2+((ny-.36)/.08)**2;
      if(d<1)c=[45,25,42,255];if(d<.72)c=[250,245,235,255];
      if(((nx-cx)/.045)**2+((ny-.375)/.058)**2<1)c=monochrome?[65,65,65,255]:[20,155,170,255];
      if(((nx-cx)/.012)**2+((ny-.35)/.02)**2<1)c=[25,25,35,255];
      if(((nx-(cx-.017))/.012)**2+((ny-.325)/.012)**2<1)c=[252,248,242,255];
    }
    const curve=.65+.03*(1-((nx-.5)/.1)**2);
    if(nx>=.4&&nx<=.6&&(open?ny>.62&&ny<.72:Math.abs(ny-curve)<.005))c=[85,25,45,255];
    data.set(c,(y*width+x)*4);
  }
  const source={width,height,data};const highlights=sourceEyeHighlights(source,face.points);
  face.highlights=highlights.map(h=>h.position);face.highlightColors=highlights.map(h=>h.color);
  face.eyes=sourceEyeDetails(source,face.points);face.mouth=sourceMouthDetail(source,face.points);
  return{source,face};
}

describe('source-supported semantic pixel layouts',()=>{
  it('measures two actual iris colors and a narrow closed mouth from source pixels',()=>{
    const{source,face}=faceFixture();
    expect(face.eyes).toHaveLength(2);for(const eye of face.eyes!){expect(eye.iris[1]).toBeGreaterThan(eye.iris[0]+70);expect(eye.position[1]).toBeGreaterThan(.34);}
    expect(face.mouth?.path.length).toBeGreaterThan(4);expect(face.mouth?.ink[0]).toBe(85);
    const blank={...source,data:Uint8ClampedArray.from(source.data,(_,i)=>[240,200,180,255][i%4])};
    expect(sourceEyeDetails(blank,face.points)).toEqual([]);expect(sourceMouthDetail(blank,face.points)).toBeUndefined();
    expect(faceFixture(true).face.mouth).toBeUndefined();
  });
  it('keeps source-supported iris and mouth contrast in the actual small-grid pipeline',async()=>{
    const{source,face}=faceFixture();
    const result=await pixelateWithExecutor(source,{...DEFAULT_SETTINGS,backend:'cpu',size:32,colors:16},async step=>{const prepared=executeCpuStep(step);if(prepared)prepared.faces=[face];return prepared;});
    let teal=0,mouth=0;for(let y=8;y<=15;y++)for(let x=4;x<28;x++){const p=(y*32+x)*4;if(result.data[p+1]>result.data[p]+50&&result.data[p+2]>result.data[p]+40)teal++;}
    for(let y=19;y<=23;y++)for(let x=11;x<=20;x++){const p=(y*32+x)*4;if(result.data[p]<180&&result.data[p+1]<130)mouth++;}
    expect(teal).toBeGreaterThanOrEqual(2);expect(mouth).toBeGreaterThanOrEqual(4);expect(result.palette.length).toBeLessThanOrEqual(16);
  });
  it('does not reinterpret a flat two-tone boundary as a new intermediate color',()=>{
    const width=2,height=1,sw=12,sh=6,colors:[number,number,number][]=[[50,60,40],[50,-30,-20],[50,15,10]],raw=new Float32Array(sw*sh*3),rgba=new Uint8ClampedArray(sw*sh*4),assignments=new Int32Array(sw*sh);
    for(let p=0;p<sw*sh;p++){const k=p%sw<6?0:1;raw.set(colors[k],p*3);rgba[p*4+3]=255;assignments[p]=k;}
    const labels=new Int16Array([2,2]);reconstructClusters(labels,raw,rgba,sw,sh,width,height,assignments,colors,.7,new Float32Array(sw*sh));
    expect([...labels]).toEqual([0,1]);
  });
  it('does not misclassify skin wedges in a monochrome eye as a colored iris',()=>{
    expect(faceFixture(false,true).face.eyes).toEqual([]);
  });
});
