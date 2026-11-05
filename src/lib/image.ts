import { isTauri } from '@tauri-apps/api/core';
import type { PixelResult, PixelSource } from '../engine/types';
export interface SourceImage {
  name: string; url: string; originalWidth: number; originalHeight: number;
  pixels: PixelSource; reduced: boolean;
}
export async function decodeImage(blob: Blob, name: string): Promise<SourceImage> {
  if (blob.size > 60 * 1024 * 1024) throw new Error('图片超过 60 MB，请选择更小的文件');
  // Decode first with the browser's orientation handling, then cap working memory.
  const bitmap = await createImageBitmap(blob);
  const originalWidth = bitmap.width, originalHeight = bitmap.height;
  if (!originalWidth || !originalHeight) { bitmap.close(); throw new Error('无法读取图片尺寸'); }
  const ratio = Math.min(1, 4096 / Math.max(originalWidth, originalHeight), Math.sqrt(12_000_000 / (originalWidth * originalHeight)));
  const width = Math.max(1, Math.round(originalWidth * ratio)), height = Math.max(1, Math.round(originalHeight * ratio));
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height); bitmap.close();
  const data = ctx.getImageData(0, 0, width, height).data;
  const preview = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('预览生成失败')), 'image/png'));
  return { name, url: URL.createObjectURL(preview), originalWidth, originalHeight, pixels: { data, width, height }, reduced: ratio < 1 };
}
export async function openNativeImage(): Promise<{ blob: Blob; name: string } | null> {
  const [{ open }, { readFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
  const path = await open({ multiple: false, directory: false, filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif'] }] });
  if (!path) return null;
  const bytes = await readFile(path);
  return { blob: new Blob([bytes]), name: path.split(/[\\/]/).pop() ?? 'image' };
}
export const native = isTauri();
export function resultCanvas(result: PixelResult) {
  const canvas = document.createElement('canvas'); canvas.width = result.width; canvas.height = result.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(result.data), result.width, result.height), 0, 0);
  return canvas;
}
export async function exportImage(result: PixelResult, name: string, scale: number, format: 'png' | 'webp') {
  const canvas = document.createElement('canvas'); canvas.width = result.width * scale; canvas.height = result.height * scale;
  const ctx = canvas.getContext('2d')!; ctx.imageSmoothingEnabled = false;
  ctx.drawImage(resultCanvas(result), 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('图片编码失败')), `image/${format}`, 1));
  if (blob.type !== `image/${format}`) throw new Error('当前系统不支持此格式，请选择 PNG');
  const filename = `${name.replace(/\.[^.]+$/, '')}-pixel-${result.width}x${result.height}@${scale}x.${format}`;
  return saveBlob(blob, filename, format);
}
export async function saveBlob(blob: Blob, filename: string, extension: string) {
  if (native) {
    const [{ save }, { writeFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
    const path = await save({ defaultPath: filename, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
    if (!path) return false;
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  } else {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  return true;
}
