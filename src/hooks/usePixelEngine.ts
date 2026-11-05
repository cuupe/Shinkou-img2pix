import { useEffect, useRef, useState } from 'react';
import type { PixelResult, PixelSource, Settings, WorkerResponse } from '../engine/types';

export function usePixelEngine(source: PixelSource | undefined, settings: Settings) {
  const worker = useRef<Worker | null>(null), previousSource = useRef<PixelSource | undefined>(undefined);
  const sequence = useRef(0), [result, setResult] = useState<PixelResult | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const instance = new Worker(new URL('../engine/pixel.worker.ts', import.meta.url), { type: 'module' });
    worker.current = instance; previousSource.current = undefined;
    instance.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== sequence.current) return;
      setBusy(false);
      if (event.data.result) { setResult(event.data.result); setError(''); }
      else setError(event.data.error ?? '处理失败');
    };
    instance.onerror = () => { setBusy(false); setError('图像处理线程异常，请重新打开应用'); };
    return () => { instance.terminate(); worker.current = null; };
  }, []);
  useEffect(() => {
    const id = ++sequence.current;
    if (!source) { setResult(null); setBusy(false); return; }
    setBusy(true); setError('');
    const timeout = setTimeout(() => {
      const nextSource = previousSource.current !== source ? source : undefined;
      previousSource.current = source;
      worker.current?.postMessage({ id, source: nextSource, settings });
    }, 100);
    return () => clearTimeout(timeout);
  }, [source, settings]);
  return { result, busy, error };
}
