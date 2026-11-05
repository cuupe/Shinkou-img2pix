import { useEffect, useState } from 'react';
import { PRESETS } from '../engine/palettes';
import { DEFAULT_SETTINGS } from '../engine/types';
import type { PixelSource, Settings, WorkerResponse } from '../engine/types';
import { resultCanvas } from '../lib/image';
export function useThumbnails(source: PixelSource | undefined, method: Settings['method'], transitionRetention: number, regionCleanup: number) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!source) return;
    let worker: Worker | null = null;
    const timer = setTimeout(() => {
      worker = new Worker(new URL('../engine/pixel.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        if (!event.data.result) return;
        const url = resultCanvas(event.data.result).toDataURL();
        const key = PRESETS[event.data.id].id;
        setThumbs(t => ({ ...t, [key]: url }));
      };
      PRESETS.forEach((p, id) => worker!.postMessage({ id, keepAll: true, source: id === 0 ? source : undefined, settings: { ...DEFAULT_SETTINGS, ...p.settings, backend: 'cpu', method, transitionRetention, regionCleanup, size: 96 } }));
    }, 200);
    return () => { clearTimeout(timer); worker?.terminate(); };
  }, [source, method, transitionRetention, regionCleanup]);
  return thumbs;
}
