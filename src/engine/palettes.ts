import type { PaletteId, RGB, Settings } from './types';

const rgb = (hex: string): RGB => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
export const PALETTES: Record<Exclude<PaletteId, 'adaptive'>, RGB[]> = {
  pico8: '000000 1d2b53 7e2553 008751 ab5236 5f574f c2c3c7 fff1e8 ff004d ffa300 ffec27 00e436 29adff 83769c ff77a8 ffccaa'.split(' ').map(rgb),
  gameboy: '0f380f 306230 8bac0f 9bbc0f'.split(' ').map(rgb),
  dusk: '24213c 39325b 54416b 75527c 99678c bd839d dba5ab f0c4b5 f5ddc4 f8edda 303e5c 3d5a70 527a83 78a394 a6c3a3 cdd9b1 84565c a96965 ca8874 e4ab86 f3cd9e 515275 777291 a19bb1'.split(' ').map(rgb),
};
export const PRESETS: { id: PaletteId; name: string; description: string; settings: Partial<Settings> }[] = [
  { id: 'adaptive', name: '自然像素', description: '提取原图色彩，保留自然层次', settings: { palette: 'adaptive', colors: 32, contrast: 0, saturation: 0, brightness: 0, dither: 'none' } },
  { id: 'pico8', name: '复古游戏', description: 'PICO-8 · 鲜明的 16 色游戏风格', settings: { palette: 'pico8', colors: 16, contrast: 8, saturation: 10, brightness: 0, dither: 'ordered' } },
  { id: 'gameboy', name: '掌机时光', description: 'Game Boy · 经典橄榄绿 4 色', settings: { palette: 'gameboy', colors: 4, contrast: 15, saturation: -100, brightness: 8, dither: 'floyd' } },
  { id: 'dusk', name: '柔和暮色', description: '24 色 · 柔和、低饱和的黄昏', settings: { palette: 'dusk', colors: 24, contrast: 0, saturation: -12, brightness: 4, dither: 'none' } },
];
export const toHex = (c: RGB) => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
