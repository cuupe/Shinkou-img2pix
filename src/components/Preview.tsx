import { useEffect, useRef, useState } from 'react';
import { Columns2, Grid2X2, Image, Maximize, Minus, Plus, Upload, ScanLine } from 'lucide-react';
import type { PixelResult } from '../engine/types';
import type { SourceImage } from '../lib/image';
import { resultCanvas } from '../lib/image';
type Mode = 'pixel' | 'original' | 'compare';
interface Props { source: SourceImage | null; result: PixelResult | null; busy: boolean; onImport: () => void }
export default function Preview({ source, result, busy, onImport }: Props) {
  const [mode, setMode] = useState<Mode>('pixel'), [zoom, setZoom] = useState(1), [grid, setGrid] = useState(false), [split, setSplit] = useState(50);
  const [bounds, setBounds] = useState({ width: 800, height: 650 });
  const viewport = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => {
    const el = viewport.current; if (!el) return;
    const observer = new ResizeObserver(([entry]) => setBounds({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!canvas.current || !result) return;
    const c = canvas.current; c.width = result.width; c.height = result.height;
    c.getContext('2d')!.drawImage(resultCanvas(result), 0, 0);
  }, [result]);
  useEffect(() => { setZoom(1); setSplit(50); }, [source]);
  const w = result?.width ?? 160, h = result?.height ?? 120;
  const fit = Math.max(0.1, Math.min((bounds.width - 50) / w, (bounds.height - 74) / h));
  const scale = fit * zoom, displayWidth = Math.round(w * scale), displayHeight = Math.round(h * scale);
  const changeZoom = (factor: number) => setZoom(z => Math.max(0.25, Math.min(8, z * factor)));
  return <main className="workspace">
    <div className="canvas-toolbar"><div className="segmented view-tabs" aria-label="预览模式">{([
      ['pixel', '像素预览', Grid2X2], ['original', '原图', Image], ['compare', '对比', Columns2],
    ] as const).map(([id, label, Icon]) => <button key={id} aria-pressed={mode === id} className={mode === id ? 'selected' : ''} onClick={() => setMode(id)}><Icon size={15} /><span>{label}</span></button>)}</div><div className="zoom-controls"><button className={`icon-button grid-button ${grid ? 'toggled' : ''}`} aria-label="像素网格" title="像素网格" aria-pressed={grid} onClick={() => setGrid(v => !v)}><Grid2X2 size={16} /></button><span className="toolbar-divider" /><button className="icon-button" aria-label="缩小" onClick={() => changeZoom(1 / 1.25)}><Minus size={16} /></button><button className="zoom-value" title="适应画布" onClick={() => setZoom(1)}>{Math.round(scale * 100)}%</button><button className="icon-button" aria-label="放大" onClick={() => changeZoom(1.25)}><Plus size={16} /></button><button className="icon-button" title="适应画布" aria-label="适应画布" onClick={() => setZoom(1)}><Maximize size={15} /></button></div></div>
    <div ref={viewport} className={`canvas-viewport ${zoom > 1 ? 'pannable' : ''}`} onWheel={e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); changeZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1); } }} onPointerDown={e => {
      if (zoom <= 1 || (e.target as HTMLElement).closest('input,button')) return;
      const el = viewport.current!; pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }; el.setPointerCapture(e.pointerId);
    }} onPointerMove={e => { if (pan.current) { viewport.current!.scrollLeft = pan.current.left - (e.clientX - pan.current.x); viewport.current!.scrollTop = pan.current.top - (e.clientY - pan.current.y); } }} onPointerUp={() => { pan.current = null; }} onPointerCancel={() => { pan.current = null; }}>
      {source && result ? <div className="canvas-stage" style={{ width: Math.max(displayWidth + 48, Math.floor(bounds.width)), height: Math.max(displayHeight + 72, Math.floor(bounds.height)) }}><div className="artwork" style={{ width: displayWidth, height: displayHeight }}>
        <canvas ref={canvas} className="pixel-canvas" aria-label="像素画预览" style={{ visibility: mode === 'original' ? 'hidden' : 'visible' }} />
        {mode !== 'pixel' && <img src={source.url} alt="原图预览" className="original-preview" style={mode === 'compare' ? { clipPath: `inset(0 ${100 - split}% 0 0)` } : undefined} draggable={false} />}
        {grid && mode !== 'original' && scale >= 4 && <div className="pixel-grid" style={{ backgroundSize: `${displayWidth / w}px ${displayHeight / h}px`, clipPath: mode === 'compare' ? `inset(0 0 0 ${split}%)` : undefined }} />}
        {mode === 'compare' && <><span className="image-label label-before">原图</span><span className="image-label label-after">像素画</span><div className="comparison-line" style={{ left: `${split}%` }}><span><Columns2 size={15} /></span></div><input className="comparison-slider" aria-label="原图对比分界线" type="range" min={0} max={100} value={split} onChange={e => setSplit(+e.target.value)} /></>}
      </div></div> : <button className="empty-state" onClick={onImport}><Upload size={30} /><strong>从一张图片开始</strong><span>拖入图片，或点击导入</span><small>PNG · JPG · WebP · BMP · GIF · AVIF</small></button>}
      {busy && <div className="processing-badge"><span className="spinner" />正在细化像素…</div>}
    </div>
    <div className="canvas-info"><div><ScanLine size={14} /><strong>{result ? `${result.width} × ${result.height}` : '—'}</strong><span>像素</span><i />{result?.palette.length ?? 0} 色</div><span className="canvas-hint">{mode === 'compare' ? '拖动分界线，对比细节' : zoom > 1 ? '拖动画布平移 · Ctrl + 滚轮缩放' : 'Ctrl + 滚轮缩放 · 拖入图片开始创作'}</span></div>
    {source && <div className="source-info"><Image size={12} /><span title={source.name}>{source.name}</span><span>{source.originalWidth} × {source.originalHeight}{source.reduced ? ' · 已优化工作分辨率' : ''}</span><button onClick={onImport}>替换图片</button></div>}
  </main>;
}
