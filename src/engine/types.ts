export type RGB = [number, number, number];
export type Dither = 'none' | 'ordered' | 'floyd';
export type PaletteId = 'adaptive' | 'pico8' | 'gameboy' | 'dusk';
export interface Settings {
  backend: 'auto' | 'gpu' | 'cpu';
  method: 'structure' | 'sample';
  lineProtection: number;
  edgeSmoothing: number;
  transitionRetention: number;
  regionCleanup: number;
  aiStrength: number;
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
export interface ExecutionInfo {
  backend: 'gpu' | 'cpu';
  device?: string;
  reason?: string;
  gpuStages: string[];
  timings: Record<string, number>;
  ai?: { backend: 'webgpu' | 'wasm' | 'none'; model: string; duration: number; cached: boolean; reason?: string; device?: string; preview?: PixelSource };
}
export interface PixelResult extends PixelSource { palette: RGB[]; duration: number; execution: ExecutionInfo }
export interface WorkerRequest { id: number; source?: PixelSource; settings: Settings; keepAll?: boolean }
export interface WorkerResponse { id: number; result?: PixelResult; error?: string }
export const DEFAULT_SETTINGS: Settings = {
  backend: 'auto',
  method: 'structure', lineProtection: 75, edgeSmoothing: 65, transitionRetention: 25, regionCleanup: 0, aiStrength: 0, cleanup: 45,
  size: 160, colors: 32, palette: 'adaptive', brightness: 0, contrast: 0,
  saturation: 0, detail: true, dither: 'none', ditherAmount: 45, transparent: true,
};
