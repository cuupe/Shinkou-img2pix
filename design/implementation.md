# 设计约定与实现核对

## 设计来源

`concept.png` 是内置 Image Gen 生成的 1536×1024 完整桌面参考。采用深色三栏本地创作工具：顶栏品牌和导入 / 导出，左侧图像参数，中间棋盘画布和模式工具栏，右侧预设、色板、导出，底部本地状态。

主提示词：Chinese Tauri image-to-pixel-art editor, Shinkou Pixel, flat dark #141619 backdrop, #1b1d21 panels, #303338 separators, restrained #c4ed91 lime accent; full-screen functional app, left pixel/color/dither inspector, central lighthouse landscape canvas with preview/original/compare toolbar, right four preset thumbnails, color swatches, PNG scaling controls. Exact Chinese labels for primary actions and section headings, no marketing hero or device mockup.

`../public/lighthouse.png` 是内置 Image Gen 单独生成的高清源图，未将设计图截图用作真实 UI 或处理结果。

源图提示词：High-resolution detailed painterly realistic 4:3 coastal landscape; white lighthouse with terracotta lantern and keeper cottage on the right, sage green grassy cliffs and daisies, turquoise sea and foamy waves on the left, warm peach sunset and layered blue headlands. Refined natural colors, clear silhouettes and architectural details readable at 128×96. No text, watermarks, UI, border, or pixel effect.

## 实现约定

- 色彩：背景 #141619，侧栏 #1b1d21，分隔 #303338，强调 #c4ed91，浅色正文、冷灰辅助文字。
- 字体：Segoe UI / Microsoft YaHei UI 本地字体；桌面品牌 26 px、侧栏标题 17 px、主控件 13–14 px；窄屏适度收紧。
- 控件：薄边框，4–8 px 圆角，统一 Lucide 线性图标，强调色只用于主要动作和选中状态。
- 容器：三栏平面工作台，侧栏以分隔线组织，不嵌套卡片；画布承担视觉主角。
- 核心文案：Shinkou Pixel、图像转像素，让灵感回到颗粒。、导入图片、导出作品、像素设置、像素尺寸、颜色数量、色彩调整、亮度、对比度、饱和度、细节增强、抖动算法、保留透明度、像素预览、原图、对比、风格预设、自然像素、复古游戏、掌机时光、柔和暮色、当前色板、导出设置、所有处理均在本地完成。

## 视觉与交互核对

Browser 插件未提供，使用 Playwright 驱动本机 Edge。截图在参考图原生尺寸 1536×1024 拍摄，并检查 390×844 窄屏。通过 `view_image` 同轮检查参考图、桌面截图和窄屏截图。

| 比较项 | 参考 | 实现与核对 |
| --- | --- | --- |
| 三栏比例 | 左侧约 22%，右侧约 25% | 桌面按 22.25vw / 24.6vw 设置，修正初版画布过宽 |
| 字号 | 品牌、段标题和控件有清晰层次 | 修正初版字号过小，桌面主控件提升为 13–14 px |
| 色彩 | 近黑背景、冷灰面板、浅绿强调 | 使用指定色值，无远程字体或额外背景渐变 |
| 画布与图片 | 棋盘背景、灯塔场景、大块像素 | 从单独高清源图实时计算，居中适应画布，最近邻显示 |
| 侧栏组织 | 分隔线、四个预设、方形色块、导出倍率 | 保留相同层级，缩略图是当前图片的真实转换结果 |
| 文案和图标 | 中文参数、模式、导出 | 保留核心文案；统一 Lucide，选中与禁用均有反馈 |
| 窄屏 | 参考未提供 | 为可用性扩展：画布置顶、双参数栏、页面滚动，无横向溢出 |

## 有意扩展与差异

- 参考图默认显示 128×96、24 色，产品默认使用长边 160 px、32 色以平衡细节；尺寸下拉显示长边，画布状态显示真实宽高，避免对不同宽高比图片作错误承诺。
- 参考艺术图不是程序输出；实际结果取决于源图和算法，保持真实输出。
- 增加必要功能：撤销/重做、重置、参数解释、文件信息、真实缩放比例、网格、GPL 色板导出、WebP、抖动强度、使用指南、键盘快捷键。
- 预设缩略图呈现固定色板和真实抖动效果，不使用预绘制假结果。
- 默认导出倍率 4x，透明度默认开启；参考中的 1x / 未选透明度是概念状态。

首屏核心标题、分区和动作中文案逐项核对；新增内容均为上述可用性扩展。已按参考校对构图、间距、字体层级、配色、图标和图片处理，无未解决的裁切、重叠或横向溢出问题。交互测试覆盖真实导入 → 参数与风格 → 对比 / 缩放 → 导出。

## 原生构建验证

`cargo check`、Release EXE 和 NSIS 安装包构建成功。使用 computer-use 启动真实 EXE，观察离线示例、160×120 / 32 色转换结果和本地耗时（约 46 ms），确认打包后的 CSP、图片资源和 Worker 正常工作；点击导入后显示 Windows 原生文件对话框。工具检测到用户正在操作窗口后停止输入；完整原生读写与安装向导未自动验证。
