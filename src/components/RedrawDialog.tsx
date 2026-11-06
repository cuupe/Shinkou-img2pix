import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Sparkles, X } from 'lucide-react';
import { dimensions } from '../engine/pixelate';
import { normalizeRedraw, redrawDimensions } from '../engine/redraw';
import type { RedrawProfile } from '../engine/redraw';
import type { PixelResult, Settings } from '../engine/types';
import { checkGenerationService, generateRedraw } from '../lib/generation';
import { decodeImage, exportImage, resultCanvas, saveBlob } from '../lib/image';
import type { SourceImage } from '../lib/image';
import { usePixelEngine } from '../hooks/usePixelEngine';
import { PALETTES } from '../engine/palettes';

interface Candidate { image: SourceImage; seed: number; prompt: string; blob: Blob; seconds: number; size: number; profile: RedrawProfile }
interface Props { source: SourceImage; baseline: PixelResult | null; settings: Settings; onClose: () => void; onApply: (result: PixelResult, patch: Partial<Settings>, seed: number, seconds: number) => void }

function GridImage({ result, label }: { result: PixelResult | null; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!result || !canvas.current) return;
    canvas.current.width = result.width; canvas.current.height = result.height;
    canvas.current.getContext('2d')!.drawImage(resultCanvas(result), 0, 0);
  }, [result]);
  return <figure><div className="redraw-art">{result ? <canvas ref={canvas} aria-label={label} /> : <span>生成后在这里检查真实像素</span>}</div><figcaption>{label}{result && ` · ${result.width} × ${result.height}`}</figcaption></figure>;
}

export default function RedrawDialog({ source, baseline, settings, onClose, onApply }: Props) {
  const [size, setSize] = useState([16, 24, 32, 48, 64].includes(settings.size) ? settings.size : 32);
  const [colors, setColors] = useState(settings.colors), [instruction, setInstruction] = useState('');
  const [seedInput, setSeedInput] = useState('');
  const [profile, setProfile] = useState<RedrawProfile>('compact');
  const [candidates, setCandidates] = useState<Candidate[]>([]), [selected, setSelected] = useState(0);
  const [phaseX, setPhaseX] = useState(0), [phaseY, setPhaseY] = useState(0);
  const [status, setStatus] = useState('正在检查本地服务…'), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const job = useRef<AbortController | null>(null), candidateRef = useRef(candidates), panel = useRef<HTMLDivElement>(null);
  const candidate = candidates[selected];
  const target = dimensions(source.pixels.width, source.pixels.height, size);
  const sourceRatio = source.pixels.width / source.pixels.height;
  const generationSize = sourceRatio >= .25 && sourceRatio <= 4 ? redrawDimensions(source.pixels.width, source.pixels.height, size, profile) : undefined;
  const colorLimit = settings.palette === 'adaptive' ? colors : PALETTES[settings.palette].length;
  const baselineMatches = baseline?.width === target.width && baseline?.height === target.height;
  const baselineSettings = useMemo(() => ({ ...settings, size, backend: 'cpu' as const }), [settings, size]);
  const comparison = usePixelEngine(baselineMatches ? undefined : source.pixels, baselineSettings);
  const matchingBaseline = baselineMatches ? baseline : comparison.result?.width === target.width && comparison.result?.height === target.height && !comparison.busy ? comparison.result : null;
  const result = useMemo(() => candidate ? normalizeRedraw(candidate.image.pixels, { size, colors, palette: settings.palette, phaseX, phaseY, target }) : null, [candidate, size, colors, settings.palette, phaseX, phaseY, target.width, target.height]);
  useEffect(() => { candidateRef.current = candidates; }, [candidates]);
  useEffect(() => {
    if (!busy) return;
    const start = performance.now(); setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((performance.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    const controller = new AbortController();
    void checkGenerationService(controller.signal).then(setStatus).catch(e => { if (!controller.signal.aborted) setStatus(e.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.key !== 'Tab' || !panel.current) return;
      const nodes = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select,[tabindex="0"]')];
      if (!nodes.length) return;
      if (event.shiftKey && (document.activeElement === nodes[0] || document.activeElement === panel.current)) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); previous?.focus(); };
  }, [onClose]);
  useEffect(() => () => { job.current?.abort(); candidateRef.current.forEach(c => URL.revokeObjectURL(c.image.url)); }, []);

  const generate = async () => {
    if (busy) return;
    const controller = new AbortController(); job.current = controller;
    const seed = seedInput.trim() ? Number(seedInput) : crypto.getRandomValues(new Uint32Array(1))[0], start = performance.now();
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) { setError('随机种子须为 0–4294967295 的整数，或留空随机。'); return; }
    setBusy(true); setError('');
    try {
      const generated = await generateRedraw(source.pixels, { size, colors: colorLimit, instruction, seed, profile }, controller.signal, setStatus);
      const image = await decodeImage(generated.blob, `重绘-${seed}.png`);
      if (controller.signal.aborted) { URL.revokeObjectURL(image.url); return; }
      const next: Candidate = { image, blob: generated.blob, seed, prompt: generated.prompt, seconds: (performance.now() - start) / 1000, size, profile };
      const nextList = [...candidateRef.current, next];
      if (nextList.length > 4) URL.revokeObjectURL(nextList.shift()!.image.url);
      candidateRef.current = nextList;
      setCandidates(nextList);
      setSelected(Math.min(candidates.length, 3)); setPhaseX(0); setPhaseY(0);
      setStatus('重绘已完成。请检查角色相似度和真实小网格，再决定是否使用。');
    } catch (e) {
      if (controller.signal.aborted) setStatus('已停止等待。已排队的任务会被移除，正在运行的任务可能继续完成。');
      else setError(e instanceof Error ? e.message : String(e));
    } finally { if (!controller.signal.aborted || job.current === controller) setBusy(false); }
  };
  return <div className="modal-backdrop redraw-backdrop" onClick={e => { e.stopPropagation(); }} onDragEnter={e => e.stopPropagation()} onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDrop={e => { e.preventDefault(); e.stopPropagation(); }}>
    <div ref={panel} className="redraw-dialog" role="dialog" aria-modal="true" aria-labelledby="redraw-title" tabIndex={-1}>
      <header><div><span className="modal-kicker">LOCAL IMAGE EDITING · EXPERIMENTAL</span><h2 id="redraw-title"><Sparkles size={21} />AI 辅助重绘</h2><p>为极小网格重新组织五官和色块。生成可能改变细节，请比较后选择。</p></div><button className="icon-button" aria-label="关闭重绘" onClick={onClose}><X size={21} /></button></header>
      <div className="redraw-body"><div className="redraw-settings">
        <label className="field">生成方式<select aria-label="重绘生成方式" value={profile} disabled={busy} onChange={e => setProfile(e.target.value as RedrawProfile)}><option value="compact">紧凑重绘 · 简化色块</option><option value="faithful">大图重绘 · 保留更多细节</option></select></label>
        <p className="help-text">{profile === 'compact' ? '用较小的生成尺寸减少结构密度，可能改变神态或漏掉细节。' : '先生成较大的候选，角色细节较多，落到小网格时也可能更碎。'}两种方式都需要检查最终网格。</p>
        <p className="help-text">{generationSize ? `本次生成 ${generationSize.width} × ${generationSize.height} 候选，再输出 ${target.width} × ${target.height} 网格。原图参考使用独立的较清晰输入。` : 'AI 重绘暂支持宽高比在 1:4 到 4:1 之间的图片。'}</p>
        <label className="field">目标长边<select aria-label="重绘像素尺寸" value={size} disabled={busy} onChange={e => setSize(+e.target.value)}>{[16, 24, 32, 48, 64].map(n => <option key={n} value={n}>{n} px</option>)}</select></label>
        <label className="field">颜色上限<select aria-label="重绘颜色数量" value={colors} disabled={busy || settings.palette !== 'adaptive'} onChange={e => setColors(+e.target.value)}>{[4, 8, 16, 24, 32, 48, 64, 128, 256].map(n => <option key={n} value={n}>{n} 色</option>)}</select></label>
        <p className="help-text">沿用当前色板风格。模型会参考原图；生成完成后再约束为真实 {target.width} × {target.height} 网格。</p>
        <label className="field">补充要求 <span className="field-hint">可选</span><textarea aria-label="重绘补充要求" maxLength={1600} value={instruction} disabled={busy} onChange={e => setInstruction(e.target.value)} placeholder="例如：保留蓝色眼睛，简化头发，不要黑色粗描边。" /></label>
        <label className="field">随机种子 <span className="field-hint">留空随机</span><input className="redraw-seed" aria-label="重绘随机种子" type="number" min={0} max={4294967295} step={1} value={seedInput} disabled={busy} onChange={e => setSeedInput(e.target.value)} /></label>
        <p className="help-text">本地模型：FLUX.2 Klein 4B FP8。8 GB 显卡使用内存卸载，首次运行较慢；透明区域会先合成白底。</p>
        <button className="button primary" disabled={busy || !generationSize} onClick={() => void generate()}><Sparkles size={16} />{candidates.length ? '再生成一张' : '生成候选'}</button>
        {busy && <button className="button" onClick={() => job.current?.abort()}>停止等待</button>}
        <p className="redraw-status" role="status">{status}{busy && <small className="redraw-elapsed">已等待 {elapsed} 秒</small>}</p>{error && <p className="redraw-error" role="alert">{error}</p>}
        <details className="redraw-setup"><summary>首次使用与服务连接</summary><p>在项目目录运行安装脚本，下载约 12.5 GB 模型；随后启动本地服务。已安装 ComfyUI 也可按说明配置。</p><code>powershell -File scripts/setup-generation.ps1</code><code>powershell -File scripts/start-generation.ps1</code><p>服务仅连接 127.0.0.1:8188。模型与服务说明见 docs/generative-redraw.md。</p></details>
      </div><div className="redraw-review">
        <div className="redraw-comparison"><figure><div className="redraw-art"><img src={source.url} alt="重绘参考原图" /></div><figcaption>参考原图</figcaption></figure><GridImage result={matchingBaseline} label="当前算法结果" /><GridImage result={result} label="候选真实网格" /></div>
        {candidate && <><div className="redraw-candidates" aria-label="重绘候选">{candidates.map((c, index) => <button key={c.seed} className={selected === index ? 'selected' : ''} onClick={() => { setSelected(index); setPhaseX(0); setPhaseY(0); }} aria-pressed={selected === index}><img src={c.image.url} alt={`重绘候选 ${index + 1}`} /><span>候选 {index + 1}</span></button>)}</div>
          <p className="help-text">候选 · {candidate.profile === 'compact' ? '紧凑重绘' : '大图重绘'} · {candidate.image.originalWidth} × {candidate.image.originalHeight} 原图 · 按 {candidate.size} px 提示生成 · 种子 {candidate.seed} · {Math.round(candidate.seconds)} 秒。{size !== candidate.size && '当前网格尺寸与生成提示不同，建议重新生成。'}{profile !== candidate.profile && '生成方式的变化在下一次生成时生效。'}大图不保证严格对齐，微调取样位置可检查眼睛和嘴是否被漏掉。</p>
          <div className="redraw-phases">{([['横向取样偏移', phaseX, setPhaseX], ['纵向取样偏移', phaseY, setPhaseY]] as const).map(([label, value, change]) => <label key={label}>{label}<output>{Math.round(value * 100)}%</output><input aria-label={label} type="range" min={-45} max={45} value={Math.round(value * 100)} onChange={e => change(+e.target.value / 100)} /></label>)}</div>
          <div className="redraw-candidate-actions"><button className="button" onClick={() => void saveBlob(candidate.blob, `shinkou-redraw-${candidate.seed}-raw.png`, 'png').catch(e => setError(String(e)))}><Download size={14} />保存生成原图</button><button className="button" disabled={!result} onClick={() => result && void exportImage(result, `shinkou-redraw-${candidate.seed}`, 1, 'png').catch(e => setError(String(e)))}>导出原尺寸候选</button><button className="button" onClick={() => void saveBlob(new Blob([JSON.stringify({ model: 'FLUX.2 Klein 4B FP8', profile: candidate.profile, generated: { width: candidate.image.originalWidth, height: candidate.image.originalHeight }, seed: candidate.seed, prompt: candidate.prompt, grid: { size, width: target.width, height: target.height, colors, palette: settings.palette, phaseX, phaseY } }, null, 2)], { type: 'application/json' }), `shinkou-redraw-${candidate.seed}.json`, 'json').catch(e => setError(String(e)))}>保存重绘参数</button></div>
        </>}
      </div></div>
      <footer><span>原图始终保留。应用后调整主界面参数，会返回算法处理。</span><button className="button" onClick={onClose}>返回编辑器</button><button className="button primary" disabled={!result || busy} onClick={() => result && candidate && onApply(result, { size, colors }, candidate.seed, candidate.seconds)}>使用此候选</button></footer>
    </div>
  </div>;
}
