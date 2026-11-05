# 本地 AI 线条辅助

0.7.0 在结构保真流水线中加入预训练神经网络提供的边缘响应，作为可关闭、可调强度的结构辅助。目标是让原图中有依据的细线获得更高保护权重，同时继续使用原有色板与规则像素网格。

## 模型与运行方式

采用 [TEED](https://github.com/xavysp/TEED)，参考论文 [Tiny and Efficient Model for the Edge Detection Generalization](https://openaccess.thecvf.com/content/ICCV2023W/RCV/papers/Soria_Tiny_and_Efficient_Model_for_the_Edge_Detection_Generalization_ICCVW_2023_paper.pdf)。它是约 58K 参数的轻量边缘检测网络。当前使用官方 BIPED epoch 7 权重，未进行额外训练。

| 项目 | 当前实现 |
| --- | --- |
| 上游版本 | `40fa4b1391dc6424f88989d0ca75d5b592c8681d` |
| 模型文件 | [teed-512.onnx](../public/models/teed-512.onnx)，248,429 字节 |
| 模型来源与 SHA-256 | [teed-model.json](../public/models/teed-model.json) |
| 模型许可 | [TEED MIT License](../public/models/TEED-LICENSE.txt) |
| 推理运行时 | ONNX Runtime Web 1.31.1；[许可与第三方声明](../public/licenses/onnxruntime/) |
| 输入 | 固定 `1 × 3 × 512 × 512`，BGR / NCHW |
| 输出 | 融合边缘图，导出图已包含 sigmoid |
| GPU | WebGPU 执行提供程序，部分算子可由 CPU 执行 |
| CPU | 单线程 WebAssembly SIMD；也作为 GPU 不可用时的推理回退 |

模型与运行时随桌面程序提供，处理图片时不联网，不需要 Python、CUDA、服务密钥或远程生图服务。约 243 KiB 的模型之外，还包含约 27.4 MiB 的 WASM 推理引擎；模型大小不代表整个 AI 功能的安装体积。

TEED 是通用边缘检测器。当前实现没有人物部件语义分类、自动识别眼睛与头发、生成式重绘或针对本项目的像素画训练。

## 数据与计算流程

1. 原图等比缩小到最长边不超过 512 px，不主动放大小图；合成白底并在右侧、下侧填充到 512 × 512。
2. 转为字节尺度 BGR，分别减去 `[103.939, 116.779, 123.68]`。不除以 255，也不使用 ImageNet 标准化。
3. 运行 TEED 融合输出，将 sigmoid 后的值 $P$ 映射为正边缘响应：$E=\mathrm{clip}_{[0,1]}(2(P-0.5))$。它用于响应强度，不解释为经过校准的语义概率。
4. 裁去填充区域供线稿预览；将响应按像素中心双线性映射到结构分析图。
5. 在原有色板提取完成后，仅增加有局部细线证据的像素重要度，再进行过渡归属、可选 SLIC、网格映射和轮廓处理。

输入图像、模型会话与边缘图按当前 Worker 中的原图引用缓存。修改强度、像素尺寸和色彩参数时复用已分析的原图；切换 CPU/GPU 模式或替换原图时重新分析。风格缩略图显示基础算法风格，不运行神经网络；主预览与导出使用同一份最终结果。

## 细线保护公式

令 $E_p$ 为映射到分析像素的神经网络响应，$u=\mathrm{clip}_{[0,1]}(\text{aiStrength}/100)$，定义：

$$
A_p=\mathrm{clip}_{[0,1]}\left(\frac{E_p-0.1}{0.6}\right).
$$

沿原有四个方向、以半径 1、2、3 取相对的不透明像素 $a,b$，以分析图亮度 $L$ 计算 $d_a=L_a-L_p$、$d_b=L_b-L_p$。仅当 $d_ad_b>0$ 时计算：

$$
V_p=\max_{a,b}\left[\min\left(1,\frac{[\min(|d_a|,|d_b|)-0.005]_+}{0.1}\right)\left[1-\frac{|L_a-L_b|}{0.25}\right]_+\right].
$$

无有效配对时 $V_p=0$。重要度更新为：

$$
I'_p=\max(I_p,uA_pV_p).
$$

这使网络响应必须同时获得原图局部明暗极值的支持。平坦区域不会仅因网络响应而出现线条；透明像素直接跳过，原有的重要度不降低。色板先由基础特征提取完成，因此在相同输入、参数与计算后端下，开启 AI 不重新训练色板，也不写回新的 RGB 中间色。

## 状态、失败与限制

界面显示模型是否就绪、AI 使用的 GPU 混合或 CPU 推理，以及是否复用分析。工具栏可独立查看 AI 线稿。该预览不会成为导出图片或取色来源。

GPU 初始化或推理失败时尝试 CPU 推理；模型缺失、校验不符或两种推理均失败时显示“AI 未生效”，继续使用基础算法。不会把基础结果标记成已使用 AI。首次初始化和模型推理会增加耗时；缓存命中仍需进行后续像素处理。

网络可能将纹理视为边缘，也可能漏掉低对比或小于模型采样尺度的细节。高强度可能使纹理更重、线条变粗，无法保证每种素材都更好。低分辨率网格依然存在信息容量限制。该功能默认关闭，可结合原图、线稿和最终像素结果调整。

## 验证与模型重建

`npm run test:ai` 使用真实模型检查 CPU 与 GPU 响应、缓存、输出色板与透明度约束、模型失败回退，并监测 GPU 队列提交，防止只凭执行选项宣称硬件推理。该检查需要支持 WebGPU 的真实硬件与浏览器。

模型转换脚本为 [export-teed.py](../scripts/export-teed.py)。如需重新导出，在独立 Python 环境安装 CPU 版 `torch==2.10.0` 和 `onnx==1.20.1` 后运行：

```powershell
python scripts/export-teed.py
```

脚本获取固定版本的上游代码与权重，移除一个未使用的诊断导入，只导出最终融合结果及 sigmoid，并记录源码和权重的校验值。普通开发、构建和使用程序均不需要执行这一步。
