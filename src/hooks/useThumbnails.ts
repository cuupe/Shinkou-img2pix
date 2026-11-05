import { useEffect, useState } from 'react';
import { PRESETS } from '../engine/palettes';
import { DEFAULT_SETTINGS } from '../engine/types';
import type { PixelSource, Settings, WorkerResponse } from '../engine/types';
import { resultCanvas } from '../lib/image';
export function useThumbnails(source: PixelSource | undefined, method: Settings['method']) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!source) return;
    const worker = new Worker(new URL('../engine/pixel.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (!event.data.result) return;
      const url = resultCanvas(event.data.result).toDataURL();
      const key = PRESETS[event.data.id].id;
      setThumbs(t => ({ ...t, [key]: url }));
    };
    PRESETS.forEach((p, id) => worker.postMessage({ id, source: id === 0 ? source : undefined, settings: { ...DEFAULT_SETTINGS, ...p.settings, method, size: 96 } }));
    return () => worker.terminate();
  }, [source, method]);
  return thumbs;
}
