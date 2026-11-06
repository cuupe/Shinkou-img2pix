import { Check, Download, ChevronDown } from 'lucide-react';
import { PALETTES, PRESETS, toHex } from '../engine/palettes';
import type { PixelResult, Settings } from '../engine/types';
import { saveBlob } from '../lib/image';
interface Props {
  settings: Settings; update: (patch: Partial<Settings>) => void; result: PixelResult | null;
  thumbs: Record<string, string>; scale: number; setScale: (n: number) => void;
  format: 'png' | 'webp'; setFormat: (v: 'png' | 'webp') => void; notify: (text: string) => void;
}
export default function StylePanel({ settings, update, result, thumbs, scale, setScale, format, setFormat, notify }: Props) {
  const exportPalette = async () => {
    if (!result) return;
    const text = `GIMP Palette\nName: Shinkou Pixel\nColumns: 8\n#\n${result.palette.map(c => `${c.join(' ')}\t${toHex(c)}`).join('\n')}\n`;
    try { if (await saveBlob(new Blob([text], { type: 'text/plain' }), 'shinkou-palette.gpl', 'gpl')) notify('色板已导出，可导入 Aseprite / GIMP'); } catch { notify('色板导出失败，请重试'); }
  };
  return <aside className="inspector right-inspector" aria-label="风格与导出设置">
    <section><h2>风格预设</h2><div className={`preset-grid ${!result ? 'preset-list' : ''}`}>{PRESETS.map(p => <button key={p.id} className={`preset ${settings.palette === p.id ? 'active' : ''}`} title={p.description} aria-pressed={settings.palette === p.id} onClick={() => update(p.settings)}><span className="preset-image">{result && thumbs[p.id] ? <img src={thumbs[p.id]} alt="" /> : <span className="preset-colors" aria-hidden="true">{(p.id === 'adaptive' ? ['#66886b', '#9caf7b', '#cdd5a1', '#eadbc2', '#bca698', '#867d7b'] : PALETTES[p.id].filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 6)) === 0).map(toHex)).map((color, index) => <i key={index} style={{ backgroundColor: color }} />)}</span>}{settings.palette === p.id && <span className="preset-check"><Check size={11} strokeWidth={3} /></span>}</span><span>{p.name}</span></button>)}</div></section>
    <section><div className="section-heading"><h2>当前色板 <span className="count">{result?.palette.length ?? 0}</span></h2><button className="icon-button" aria-label="导出色板" title="导出 GPL 色板" disabled={!result?.palette.length} onClick={exportPalette}><Download size={14} /></button></div>{result ? <><div className="swatches">{result.palette.map((color, i) => <button key={i} style={{ background: toHex(color) }} title={`${toHex(color)} · 点击复制`} aria-label={`复制颜色 ${toHex(color)}`} onClick={async () => { try { await navigator.clipboard.writeText(toHex(color)); notify(`已复制 ${toHex(color)}`); } catch { notify(`颜色：${toHex(color)}`); } }} />)}</div><p className="help-text">点击色块复制 HEX 色值</p></> : <p className="palette-empty">导入图片后生成色板</p>}</section>
    <section><h2>导出设置</h2><label className="inline-field">格式<span className="select-wrapper"><select value={format} onChange={e => setFormat(e.target.value as 'png' | 'webp')} aria-label="导出格式"><option value="png">PNG · 无损</option><option value="webp">WebP</option></select><ChevronDown size={13} /></span></label><label className="export-label">导出缩放</label><div className="scale-options">{[1, 2, 4, 8].map(n => <button key={n} className={scale === n ? 'selected' : ''} aria-pressed={scale === n} onClick={() => setScale(n)}>{n}x</button>)}</div><p className="export-dimensions">{result ? `${result.width * scale} × ${result.height * scale} px` : '—'} <span>最近邻放大</span></p></section>
    <div className="rail-note">无损保存，保留每一格清晰边缘。</div>
  </aside>;
}
