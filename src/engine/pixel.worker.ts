/// <reference lib="webworker" />
import { pixelate } from './pixelate';
import type { PixelSource, WorkerRequest, WorkerResponse } from './types';

let source: PixelSource | undefined;
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, settings } = event.data;
  source = event.data.source ?? source;
  try {
    if (!source) throw new Error('请先导入图片');
    const result = pixelate(source, settings);
    const response: WorkerResponse = { id, result };
    self.postMessage(response, [result.data.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse);
  }
};
