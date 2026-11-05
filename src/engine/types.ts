export type RGB = [number, number, number];
export type Dither = 'none' | 'ordered' | 'floyd';
export type PaletteId = 'adaptive' | 'pico8' | 'gameboy' | 'dusk';
export interface Settings {
  method: 'structure' | 'sample';
  lineProtection: number;
  edgeSmoothing: number;
  cleanup: number;
  size: number;
  colors: number;
  palette: PaletteId;
  brightness: number;
  contrast: number;
  saturation: number;
  detail: boolean;
  dither: Dither;
  ditherAmount: number;
  transparent: boolean;
}
export interface PixelSource { data: Uint8ClampedArray; width: number; height: number }
export interface PixelResult extends PixelSource { palette: RGB[]; duration: number }
export interface WorkerRequest { id: number; source?: PixelSource; settings: Settings }
export interface WorkerResponse { id: number; result?: PixelResult; error?: string }
export const DEFAULT_SETTINGS: Settings = {
  method: 'structure', lineProtection: 75, edgeSmoothing: 65, cleanup: 45,
  size: 160, colors: 32, palette: 'adaptive', brightness: 0, contrast: 0,
  saturation: 0, detail: true, dither: 'none', ditherAmount: 45, transparent: true,
};
