import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Download, ImagePlus, X, CheckCircle2, CircleHelp, Upload, Sparkles } from 'lucide-react';
import Controls from './components/Controls';
import Preview from './components/Preview';
import StylePanel from './components/StylePanel';
import { usePixelEngine } from './hooks/usePixelEngine';
import { useSettings } from './hooks/useSettings';
import { useThumbnails } from './hooks/useThumbnails';
import { decodeImage, exportImage, native, openNativeImage } from './lib/image';
import type { SourceImage } from './lib/image';
import { usesReconstruction } from './engine/types';
import type { PixelResult, Settings } from './engine/types';

const RedrawDialog = lazy(() => import('./components/RedrawDialog'));

export default function App() {
  const [source, setSource] = useState<SourceImage | null>(null), [toast, setToast] = useState('');
  const [scale, setScale] = useState(4), [format, setFormat] = useState<'png' | 'webp'>('png');
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [dragging, setDragging] = useState(false), [help, setHelp] = useState(false);
  const input = useRef<HTMLInputElement>(null), loadId = useRef(0), toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), dragDepth = useRef(0);
  const history = useSettings();
  const [redrawOpen, setRedrawOpen] = useState(false);
  const [appliedRedraw, setAppliedRedraw] = useState<{ source: SourceImage; settings: string; result: PixelResult; seed: number; seconds: number } | null>(null);
  const algorithm = usePixelEngine(source?.pixels, history.settings);
  const activeRedraw = appliedRedraw?.source === source && appliedRedraw.settings === JSON.stringify(history.settings) ? appliedRedraw : null;
  const result = activeRedraw?.result ?? algorithm.result, busy = !activeRedraw && algorithm.busy, error = activeRedraw ? null : algorithm.error;
  const closeRedraw = useCallback(() => setRedrawOpen(false), []);
  const applyRedraw = useCallback((candidate: PixelResult, patch: Partial<Settings>, seed: number, seconds: number) => {
    if (!source) return;
    history.update(patch);
    setAppliedRedraw({ source, settings: JSON.stringify({ ...history.settings, ...patch }), result: candidate, seed, seconds });
    setRedrawOpen(false);
  }, [source, history.settings, history.update]);
  const thumbs = useThumbnails(source?.pixels, history.settings.method, history.settings.transitionRetention, history.settings.regionCleanup);
  const notify = useCallback((text: string) => { setToast(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4200); }, []);
  const load = useCallback(async (blob: Blob, name: string) => {
    const id = ++loadId.current; setLoading(true);
    try {
      const next = await decodeImage(blob, name);
      if (id !== loadId.current) { URL.revokeObjectURL(next.url); return; }
      setAppliedRedraw(null);
      setSource(next);
    } catch { if (id === loadId.current) notify('无法读取图片，请确认文件有效且不超过 60 MB。'); }
    finally { if (id === loadId.current) setLoading(false); }
  }, [notify]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/illustration.png', { signal: controller.signal }).then(r => { if (!r.ok) throw new Error(); return r.blob(); }).then(blob => { if (!controller.signal.aborted && loadId.current === 0) void load(blob, '星之旅人 · 插画示例.png'); }).catch(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load]);
  useEffect(() => () => { if (source) URL.revokeObjectURL(source.url); }, [source]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const importImage = useCallback(async () => {
    if (!native) { input.current?.click(); return; }
    try { const file = await openNativeImage(); if (file) await load(file.blob, file.name); }
    catch { notify('无法打开图片，请重试或将图片拖入窗口。'); }
  }, [load, notify]);
  const save = useCallback(async () => {
    if (!result || !source || busy || loading || saving || error) return;
    setSaving(true);
    const exportName = activeRedraw ? `${source.name.replace(/\.[^.]+$/, '')}-redraw-${activeRedraw.seed}.png` : source.name;
    try { if (await exportImage(result, exportName, scale, format)) notify(`作品已导出 · ${result.width * scale} × ${result.height * scale} px`); }
    catch { notify('导出失败，请检查保存位置是否可写。'); }
    finally { setSaving(false); }
  }, [result, source, busy, loading, saving, error, scale, format, notify, activeRedraw]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (redrawOpen) return;
      if (e.key === 'Escape') setHelp(false);
      if (!(e.ctrlKey || e.metaKey) || (e.target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName))) return;
      const key = e.key.toLowerCase();
      if (key === 'o') { e.preventDefault(); void importImage(); }
      if (key === 's') { e.preventDefault(); void save(); }
      if (key === 'z') { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); }
      if (key === 'y') { e.preventDefault(); history.redo(); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [history.undo, history.redo, importImage, save, redrawOpen]);
  return <div className="app" onDragEnter={e => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true); } }} onDragOver={e => e.preventDefault()} onDragLeave={e => { e.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) { setDragging(false); dragDepth.current = 0; } }} onDrop={e => { e.preventDefault(); setDragging(false); dragDepth.current = 0; const file = e.dataTransfer.files[0]; if (file) void load(file, file.name); }}>
    <header className="app-header"><div className="brand"><span className="pixel-logo" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} />)}</span><h1>Shinkou <span>Pixel</span></h1><span className="brand-divider" /><p>图像转像素，让灵感回到颗粒。</p></div><div className="header-actions"><button className="button" disabled={!source || loading} onClick={() => setRedrawOpen(true)}><Sparkles size={17} />AI 辅助重绘</button><button className="button" onClick={importImage} disabled={loading}><ImagePlus size={17} />导入图片</button><button className="button primary" onClick={save} disabled={!result || busy || loading || saving || !!error}><Download size={17} />{saving ? '正在导出…' : '导出作品'}</button></div></header>
    {activeRedraw && <div className="redraw-banner"><Sparkles size={14} /><span>当前显示 AI 重绘候选 · 种子 {activeRedraw.seed} · 原图已保留</span><button onClick={() => setAppliedRedraw(null)}>返回算法结果</button></div>}
    <div className="editor"><Controls {...history} reconstructionActive={!!source && usesReconstruction(source.pixels, history.settings)} ai={busy ? undefined : result?.execution.ai} semantic={busy ? undefined : result?.execution.semantic} /><Preview source={source} result={result} busy={busy || loading} onImport={importImage} notify={notify} /><StylePanel settings={history.settings} update={history.update} result={result} thumbs={thumbs} scale={scale} setScale={setScale} format={format} setFormat={setFormat} notify={notify} /></div>
    <footer className="status-bar"><span><i className={`status-dot ${error ? 'error' : ''}`} />{error || (activeRedraw ? '本地 AI 重绘候选 · 可与原图比较' : busy || loading ? '正在本地处理图片…' : '所有处理均在本地完成')}</span><div>{result && !busy && <span className="backend-status" title={activeRedraw ? '本机 ComfyUI 生成候选，CPU 完成网格取样与色板约束。时间包含排队与模型加载。' : [result.execution.device, result.execution.reason, result.execution.gpuStages.length ? `GPU 阶段：${result.execution.gpuStages.join('、')}` : '全部阶段使用 CPU'].filter(Boolean).join('\n')}>{activeRedraw ? '本地 AI' : result.execution.backend === 'gpu' ? 'GPU 混合' : result.execution.reason?.startsWith('GPU 回退') ? 'CPU · 已回退' : 'CPU'}</span>}<span className="processing-time">{activeRedraw ? `${Math.round(activeRedraw.seconds)} s` : result && !busy ? `${Math.round(result.duration)} ms` : ''}</span><button className="help-button" onClick={() => setHelp(true)}><CircleHelp size={13} />使用指南</button><span className="version">v0.10.1</span></div></footer>
    <input ref={input} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif,image/avif" aria-label="选择图片文件" onChange={e => { const file = e.target.files?.[0]; if (file) void load(file, file.name); e.target.value = ''; }} />
    {toast && <div className="toast" role="status"><CheckCircle2 size={16} /><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast('')}><X size={14} /></button></div>}
    {dragging && <div className="drop-overlay"><Upload size={42} /><strong>放下图片，开始像素创作</strong><span>PNG / JPG / WebP / BMP / GIF / AVIF · 最大 60 MB</span></div>}
    {redrawOpen && source && <Suspense fallback={<div className="modal-backdrop">正在打开重绘面板…</div>}><RedrawDialog source={source} baseline={algorithm.result} settings={history.settings} onClose={closeRedraw} onApply={applyRedraw} /></Suspense>}
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><div className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={e => e.stopPropagation()}><button className="modal-close icon-button" aria-label="关闭指南" autoFocus onClick={() => setHelp(false)}><X size={20} /></button><span className="modal-kicker">SHINKOU PIXEL</span><h2 id="help-title">让照片，成为像素作品。</h2><ol><li><strong>导入图片</strong><p>点击导入，或直接拖入文件。建议选择主体清晰、明暗分明的图片。GIF 读取首帧。</p></li><li><strong>找到合适的颗粒</strong><p>像素尺寸表示长边的像素数，越小颗粒越明显。32–64 px 默认使用色块重构，并可单独调整描边、短笔画和动漫五官。96 px 及以上沿用原有处理，少于一格的信息仍需要取舍。</p></li><li><strong>调出自己的风格</strong><p>动漫、插画优先使用结构保真。过渡色保留越低，边缘越偏向主色；100 关闭边缘过渡归并。颜色数量控制整张色板，轮廓规整控制格子形状，三者可分别调整。</p></li><li><strong>保存清晰的边缘</strong><p>使用 PNG 保留透明背景。2x / 4x / 8x 均为最近邻整数倍放大，不会模糊像素。</p></li></ol><div className="shortcuts"><span>导入 <kbd>Ctrl O</kbd></span><span>导出 <kbd>Ctrl S</kbd></span><span>撤销 <kbd>Ctrl Z</kbd></span></div><button className="button primary" onClick={() => setHelp(false)}>开始创作</button></div></div>}
  </div>;
}
