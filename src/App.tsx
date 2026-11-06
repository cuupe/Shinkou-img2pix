import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, ImagePlus, X, CheckCircle2, CircleHelp, Upload, Sparkles, Settings as SettingsIcon } from 'lucide-react';
import Controls from './components/Controls';
import Preview from './components/Preview';
import StylePanel from './components/StylePanel';
import SettingsPage from './components/SettingsPage';
import type { SettingsSection } from './components/SettingsPage';
import { usePreferences } from './hooks/usePreferences';
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
  const { preferences, updatePreferences, resetPreferences, storageError } = usePreferences();
  const [scale, setScale] = useState<number>(preferences.exportScale), [format, setFormat] = useState<'png' | 'webp'>(preferences.exportFormat);
  const [page, setPage] = useState<'editor' | 'settings'>('editor');
  const [settingsLocation, setSettingsLocation] = useState({ section: 'appearance' as SettingsSection, visit: 0 });
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [dragging, setDragging] = useState(false);
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
  const openSettings = useCallback((section: SettingsSection = 'appearance') => { setSettingsLocation(p => ({ section, visit: p.visit + 1 })); setPage('settings'); }, []);
  useEffect(() => { setFormat(preferences.exportFormat); setScale(preferences.exportScale); }, [preferences.exportFormat, preferences.exportScale]);
  const load = useCallback(async (blob: Blob, name: string) => {
    const id = ++loadId.current; setLoading(true);
    try {
      const next = await decodeImage(blob, name);
      if (id !== loadId.current) { URL.revokeObjectURL(next.url); return; }
      setAppliedRedraw(null);
      setSource(next);
      setPage('editor');
    } catch { if (id === loadId.current) notify('无法读取图片，请确认文件有效且不超过 60 MB。'); }
    finally { if (id === loadId.current) setLoading(false); }
  }, [notify]);
  const openExample = useCallback(async () => {
    const id = ++loadId.current; setLoading(true);
    try {
      const response = await fetch('/illustration.png');
      if (!response.ok) throw new Error('Example unavailable');
      const blob = await response.blob();
      if (id === loadId.current) await load(blob, '星之旅人 · 插画示例.png');
    } catch { if (id === loadId.current) notify('示例暂时无法打开，请导入自己的图片。'); }
    finally { if (id === loadId.current) setLoading(false); }
  }, [load, notify]);
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
      if (e.key === 'Escape') setPage('editor');
      if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openSettings(); return; }
      if (page === 'settings') return;
      if (!(e.ctrlKey || e.metaKey) || (e.target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName))) return;
      const key = e.key.toLowerCase();
      if (key === 'o') { e.preventDefault(); void importImage(); }
      if (key === 's') { e.preventDefault(); void save(); }
      if (key === 'z') { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); }
      if (key === 'y') { e.preventDefault(); history.redo(); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [history.undo, history.redo, importImage, save, redrawOpen, page, openSettings]);
  return <div className="app" onDragEnter={e => { if (page !== 'editor') return; e.preventDefault(); if (e.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true); } }} onDragOver={e => e.preventDefault()} onDragLeave={e => { e.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) { setDragging(false); dragDepth.current = 0; } }} onDrop={e => { e.preventDefault(); setDragging(false); dragDepth.current = 0; if (page !== 'editor') return; const file = e.dataTransfer.files[0]; if (file) void load(file, file.name); }}>
    <header className="app-header"><div className="brand"><span className="pixel-logo" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} />)}</span><h1>Shinkou <span>Pixel</span></h1></div><nav className="app-nav" aria-label="主导航"><button aria-current={page === 'editor' ? 'page' : undefined} onClick={() => setPage('editor')}>工作台</button><button aria-current={page === 'settings' ? 'page' : undefined} onClick={() => openSettings()}><SettingsIcon size={15} /><span>设置</span></button></nav><div className="header-actions">{page === 'editor' ? <><button className="button redraw-action" disabled={!source || loading} onClick={() => setRedrawOpen(true)}><Sparkles size={16} /><span>AI 辅助重绘</span></button><button className="button" onClick={importImage} disabled={loading}><ImagePlus size={16} />导入图片</button><button className="button primary export-action" onClick={save} disabled={!result || busy || loading || saving || !!error}><Download size={16} /><span>{saving ? '正在导出…' : '导出作品'}</span></button></> : <button className="button" onClick={() => setPage('editor')}><ArrowLeft size={16} />返回工作台</button>}</div></header>
    {page === 'editor' && activeRedraw && <div className="redraw-banner"><Sparkles size={14} /><span>当前显示 AI 重绘候选 · 种子 {activeRedraw.seed} · 原图已保留</span><button onClick={() => setAppliedRedraw(null)}>返回算法结果</button></div>}
    <div className="editor" hidden={page !== 'editor'}><Controls {...history} reconstructionActive={!!source && usesReconstruction(source.pixels, history.settings)} ai={busy ? undefined : result?.execution.ai} semantic={busy ? undefined : result?.execution.semantic} /><Preview source={source} result={result} busy={busy || loading} onImport={importImage} onExample={openExample} onGuide={() => openSettings('guide')} onClear={() => { loadId.current++; setSource(null); setAppliedRedraw(null); setLoading(false); }} notify={notify} /><StylePanel settings={history.settings} update={history.update} result={result} thumbs={thumbs} scale={scale} setScale={setScale} format={format} setFormat={setFormat} notify={notify} /></div>
    {page === 'settings' && <SettingsPage key={settingsLocation.visit} preferences={preferences} update={updatePreferences} reset={() => { resetPreferences(); notify('已恢复默认偏好'); }} onBack={() => setPage('editor')} initialSection={settingsLocation.section} storageError={storageError} />}
    <footer className="status-bar"><span><i className={`status-dot ${error ? 'error' : ''}`} />{page === 'settings' ? '按 Esc 返回工作台' : error || (activeRedraw ? '本地 AI 重绘候选 · 可与原图比较' : busy || loading ? '正在本地处理图片…' : '所有处理均在本地完成')}</span><div>{page === 'editor' && result && !busy && <span className="backend-status" title={activeRedraw ? '本机 ComfyUI 生成候选，CPU 完成网格取样与色板约束。时间包含排队与模型加载。' : [result.execution.device, result.execution.reason, result.execution.gpuStages.length ? `GPU 阶段：${result.execution.gpuStages.join('、')}` : '全部阶段使用 CPU'].filter(Boolean).join('\n')}>{activeRedraw ? '本地 AI' : result.execution.backend === 'gpu' ? 'GPU 混合' : result.execution.reason?.startsWith('GPU 回退') ? 'CPU · 已回退' : 'CPU'}</span>}<span className="processing-time">{page !== 'editor' ? '' : activeRedraw ? `${Math.round(activeRedraw.seconds)} s` : result && !busy ? `${Math.round(result.duration)} ms` : ''}</span><button className="help-button" onClick={() => openSettings('guide')}><CircleHelp size={13} />使用指南</button><span className="version">v1.0.0</span></div></footer>
    <input ref={input} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif,image/avif" aria-label="选择图片文件" onChange={e => { const file = e.target.files?.[0]; if (file) void load(file, file.name); e.target.value = ''; }} />
    {toast && <div className="toast" role="status"><CheckCircle2 size={16} /><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast('')}><X size={14} /></button></div>}
    {dragging && <div className="drop-overlay"><Upload size={42} /><strong>放下图片，开始像素创作</strong><span>PNG / JPG / WebP / BMP / GIF / AVIF · 最大 60 MB</span></div>}
    {redrawOpen && source && <Suspense fallback={<div className="modal-backdrop">正在打开重绘面板…</div>}><RedrawDialog source={source} baseline={algorithm.result} settings={history.settings} onClose={closeRedraw} onApply={applyRedraw} /></Suspense>}
  </div>;
}
