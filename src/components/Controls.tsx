import { RotateCcw, Undo2, Redo2, SlidersHorizontal } from 'lucide-react';
import type { Settings } from '../engine/types';

export function Slider({ label, value, min = -50, max = 50, onChange }: { label: string; value: number; min?: number; max?: number; onChange: (value: number) => void }) {
  return <label className="slider-control"><span>{label}<output>{min < 0 && value > 0 ? '+' : ''}{value}</output></span><input aria-label={label} type="range" min={min} max={max} value={value} onChange={e => onChange(+e.target.value)} style={{ '--fill': `${(value - min) / (max - min) * 100}%` } as React.CSSProperties} /></label>;
}
export function Toggle({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (value: boolean) => void; hint?: string }) {
  return <label className="toggle-control"><span>{label}{hint && <small>{hint}</small>}</span><input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} /><span className="switch" aria-hidden="true" /></label>;
}
interface Props {
  settings: Settings; update: (patch: Partial<Settings>) => void;
  undo: () => void; redo: () => void; reset: () => void; canUndo: boolean; canRedo: boolean;
}
export default function Controls({ settings: s, update, undo, redo, reset, canUndo, canRedo }: Props) {
  return <aside className="inspector left-inspector" aria-label="图像处理参数">
    <section><div className="section-heading"><h2><SlidersHorizontal size={16} />像素设置</h2><div className="mini-actions"><button className="icon-button" title="撤销 (Ctrl+Z)" aria-label="撤销" disabled={!canUndo} onClick={undo}><Undo2 size={15} /></button><button className="icon-button" title="重做 (Ctrl+Shift+Z)" aria-label="重做" disabled={!canRedo} onClick={redo}><Redo2 size={15} /></button><button className="icon-button" title="恢复默认参数" aria-label="恢复默认参数" onClick={reset}><RotateCcw size={14} /></button></div></div>
    <label className="field">转换方式<select value={s.method} aria-label="转换方式" onChange={e => update({ method: e.target.value as Settings['method'] })}><option value="structure">结构保真 · 动漫 / 插画</option><option value="sample">照片采样 · 原有算法</option></select></label>
    <label className="field">像素尺寸 <span className="field-hint">长边</span><select value={s.size} onChange={e => update({ size: +e.target.value })} aria-label="像素尺寸">{[32, 48, 64, 96, 128, 160, 192, 256, 384, 512].map(n => <option key={n} value={n}>{n} px{n === 160 ? ' · 推荐' : ''}</option>)}</select></label>
    <label className="field">颜色数量<select value={s.colors} disabled={s.palette !== 'adaptive'} onChange={e => update({ colors: +e.target.value })} aria-label="颜色数量">{[4, 8, 16, 24, 32, 48, 64, 128, 256].map(n => <option key={n} value={n}>{n} 色</option>)}</select></label>
    <p className="help-text">{s.palette === 'adaptive' ? '从原图提取色板，让每一种颜色恰到好处。' : '经典风格使用固定色板，切换自然像素可自定色数。'}</p></section>
    <section><h2>色彩调整</h2><Slider label="亮度" value={s.brightness} onChange={brightness => update({ brightness })} /><Slider label="对比度" value={s.contrast} onChange={contrast => update({ contrast })} /><Slider label="饱和度" min={-100} max={100} value={s.saturation} onChange={saturation => update({ saturation })} /></section>
    {s.method === 'structure' ? <section><h2>轮廓与色块</h2><Slider label="线条保护" min={0} max={100} value={s.lineProtection} onChange={lineProtection => update({ lineProtection })} /><Slider label="碎点合并" min={0} max={100} value={s.cleanup} onChange={cleanup => update({ cleanup })} /><p className="help-text">先分析细线，再让颜色区域落入网格。提高保护可保留窄线，但也可能加粗纹理。</p><p className="structure-note">每格纯色 · 不使用抖动<br />少于一格的细节需要取舍，建议先尝试 128–256 px。</p></section> : <><section><Toggle label="细节增强" hint="让轮廓更清晰" value={s.detail} onChange={detail => update({ detail })} /></section>
    <section><h2>抖动算法</h2><div className="segmented dither-tabs" aria-label="抖动算法">{([['none', '无'], ['ordered', '有序'], ['floyd', '误差扩散']] as const).map(([id, name]) => <button key={id} aria-pressed={s.dither === id} className={s.dither === id ? 'selected' : ''} onClick={() => update({ dither: id })}>{name}</button>)}</div><p className="help-text">{s.dither === 'none' ? '干净的色块，适合插画与清晰轮廓。' : s.dither === 'ordered' ? 'Bayer 4×4 纹理，营造规整复古颗粒。' : 'Floyd–Steinberg 蛇形扩散，过渡更自然。'}</p>{s.dither !== 'none' && <Slider label="抖动强度" min={0} max={100} value={s.ditherAmount} onChange={ditherAmount => update({ ditherAmount })} />}</section></>}
    <section><Toggle label="保留透明度" hint="关闭后以白色背景合成" value={s.transparent} onChange={transparent => update({ transparent })} /></section>
    <div className="rail-note"><span className="tiny-pixel" />每一个像素，都有自己的位置。</div>
  </aside>;
}
