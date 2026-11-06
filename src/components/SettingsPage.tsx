import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Check, Download, Info, Monitor, RotateCcw } from 'lucide-react';
import { Toggle } from './Controls';
import type { Preferences } from '../lib/preferences';

export type SettingsSection = 'appearance' | 'export' | 'guide' | 'about';
const sections = [
  { id: 'appearance', label: '外观', icon: Monitor }, { id: 'export', label: '默认导出', icon: Download },
  { id: 'guide', label: '使用指南', icon: BookOpen }, { id: 'about', label: '关于', icon: Info },
] as const;
interface Props {
  preferences: Preferences; update: (patch: Partial<Preferences>) => void; reset: () => void;
  onBack: () => void; initialSection: SettingsSection; storageError: boolean;
}
export default function SettingsPage({ preferences: p, update, reset, onBack, initialSection, storageError }: Props) {
  const [active, setActive] = useState<SettingsSection>(initialSection);
  const content = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);
  const scrollToSection = (section: SettingsSection) => {
    setActive(section);
    const element = content.current?.querySelector<HTMLElement>(`#settings-${section}`);
    if (element && content.current) content.current.scrollTo({ top: section === 'appearance' ? 0 : element.offsetTop - 24, behavior: 'instant' });
  };
  useEffect(() => { scrollToSection(initialSection); }, [initialSection]);
  useEffect(() => { main.current?.focus({ preventScroll: true }); }, []);
  return <main className="settings-page" aria-label="应用设置" tabIndex={-1} ref={main}>
    <nav className="settings-nav" aria-label="设置分类">{sections.map(({ id, label, icon: Icon }) => <button key={id} aria-current={active === id ? 'location' : undefined} onClick={() => scrollToSection(id)}><Icon size={18} />{label}</button>)}<button className="settings-back" onClick={onBack}><ArrowLeft size={16} />返回工作台</button></nav>
    <div className="settings-scroll" ref={content} onScroll={() => {
      const top = content.current?.scrollTop ?? 0;
      const section = [...sections].reverse().find(({ id }) => (content.current?.querySelector<HTMLElement>(`#settings-${id}`)?.offsetTop ?? Infinity) <= top + 100);
      if (section) setActive(section.id);
    }}>
      <div className="settings-content">
        <header className="settings-heading"><div><h2>设置</h2><p>让工作台适合你的创作习惯。</p></div><span className={storageError ? 'save-state storage-error' : 'save-state'} role="status">{storageError ? '当前仅在本次会话生效，无法保存偏好' : <><Check size={13} />偏好自动保存在本机</>}</span></header>
        <section id="settings-appearance" aria-labelledby="appearance-title">
          <h3 id="appearance-title">外观</h3>
          <div className="setting-row theme-row"><div className="setting-label">主题<p>跟随系统会随 Windows 外观自动切换。</p></div><div className="theme-options" role="group" aria-label="主题">{([['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']] as const).map(([id, label]) => <button key={id} className={`theme-option ${p.theme === id ? 'selected-theme' : ''}`} aria-pressed={p.theme === id} onClick={() => update({ theme: id })}><span className={`theme-miniature miniature-${id}`} aria-hidden="true"><i /><span /><b /></span><span className="theme-option-label"><span className="choice-dot">{p.theme === id && <Check size={10} strokeWidth={3} />}</span>{label}</span></button>)}</div></div>
          <div className="setting-row"><div className="setting-label">强调色<p>统一应用于按钮、选中状态和参数控件。</p></div><div className="accent-options" role="group" aria-label="强调色">{([['lime', '萤草绿'], ['blue', '晴空蓝'], ['violet', '鸢尾紫']] as const).map(([id, label]) => <button key={id} aria-label={label} aria-pressed={p.accent === id} onClick={() => update({ accent: id })}><i className={`accent-dot accent-${id}`}>{p.accent === id && <Check size={14} strokeWidth={3} />}</i><span>{label}</span></button>)}</div></div>
          <div className="setting-row"><Toggle label="减少动态效果" hint="关闭界面过渡；系统的减少动画偏好也会生效。" value={p.reducedMotion} onChange={reducedMotion => update({ reducedMotion })} /></div>
          <div className="setting-row"><label className="setting-label" htmlFor="canvas-background">画布背景<p>只改变预览区域，不影响导出的透明度。</p></label><select id="canvas-background" value={p.canvas} onChange={e => update({ canvas: e.target.value as Preferences['canvas'] })}><option value="checker">棋盘格</option><option value="solid">纯色</option></select></div>
        </section>
        <section id="settings-export" aria-labelledby="export-title"><h3 id="export-title">默认导出</h3><div className="export-defaults"><label className="field">默认格式<select value={p.exportFormat} onChange={e => update({ exportFormat: e.target.value as Preferences['exportFormat'] })}><option value="png">PNG · 无损</option><option value="webp">WebP</option></select></label><label className="field">默认倍率<select value={p.exportScale} onChange={e => update({ exportScale: +e.target.value as Preferences['exportScale'] })}>{[1, 2, 4, 8].map(n => <option key={n} value={n}>{n}x{n === 1 ? ' · 真实像素' : ''}</option>)}</select></label></div><p className="settings-note">修改后立即应用并保存。工作台的导出面板仍可临时调整，不会覆盖这里的默认值。</p></section>
        <section id="settings-guide" aria-labelledby="guide-title"><h3 id="guide-title">使用指南</h3><ol className="guide-steps"><li><strong>导入图片</strong><p>点击「导入图片」、按 Ctrl + O，或将本地文件拖入工作台。支持 PNG、JPG、WebP、BMP、GIF、AVIF，最大 60 MB；GIF 仅读取首帧。启动时不会打开测试图片，「打开示例」需要手动选择。</p></li><li><strong>调整与对比</strong><p>动漫与插画可从「结构保真」、长边 160 px、32 色开始；照片可选「照片采样」。像素尺寸越小，颗粒越明显；32–64 px 可尝试色块重构。选择「对比」并拖动分界线检查细节，网格取色读取结果的真实颜色。</p></li><li><strong>清晰导出</strong><p>1x 保存真实像素尺寸，2x / 4x / 8x 使用最近邻放大，边缘保持清晰。需要透明背景时，开启「保留透明度」并使用 PNG。色板可单独导出为 GPL。</p></li></ol>
          <details className="guide-ai"><summary>AI 辅助重绘如何使用？</summary><p>这是可选的生成式功能，普通像素转换无需安装 ComfyUI。重绘需要 NVIDIA 显卡、配套 Python 环境和约 12.5 GB 模型；环境整体约需 20 GB 以上空间。</p><p>首次使用运行 <code>scripts/setup-generation.cmd</code>，之后运行 <code>scripts/start-generation.cmd</code> 并保持窗口开启，再导入图片、点击「AI 辅助重绘」。已有环境可直接启动。</p><p>服务仅连接本机 127.0.0.1:8188。模型可能改变角色特征，请比较候选与原图后再应用。关闭主应用不会自动停止服务；ComfyUI 的 input / output 目录会保留图片。</p><p>环境可安装在其他磁盘：安装与启动脚本使用同一 <code>-RuntimePath</code> 参数指定目录。</p></details>
          <div className="shortcut-list"><span>导入 <kbd>Ctrl O</kbd></span><span>导出 <kbd>Ctrl S</kbd></span><span>撤销 <kbd>Ctrl Z</kbd></span><span>重做 <kbd>Ctrl Shift Z</kbd></span><span>设置 <kbd>Ctrl ,</kbd></span></div>
        </section>
        <section id="settings-about" aria-labelledby="about-title"><h3 id="about-title">关于 Shinkou Pixel <span className="version">v1.0.0</span></h3><p className="settings-note">所有图像处理均在本机完成。普通转换、AI 线条辅助与生成式重绘使用不同的处理路径；生成式重绘只在你主动提交候选时发送图片到本机服务。</p><div className="settings-reset"><div><strong>恢复默认偏好</strong><p>重置主题、画布与导出默认值。当前图片和转换参数会保留。</p></div><button className="button" onClick={reset}><RotateCcw size={14} />恢复默认偏好</button></div></section>
      </div>
    </div>
  </main>;
}
