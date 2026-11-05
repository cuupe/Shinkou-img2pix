/// <reference lib="webworker" />
import { pixelateAccelerated } from './backend';
import type { PixelSource, WorkerRequest, WorkerResponse } from './types';

let source: PixelSource | undefined;
let running = false;
let pending: WorkerRequest[] = [];
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  source = event.data.source ?? source;
  // Capture source per request and serialize GPU work. Pending previews coalesce;
  // thumbnail batches explicitly request every result.
  if (!event.data.keepAll) pending = pending.filter(request => request.keepAll);
  pending.push({ ...event.data, source });
  void drain();
};
async function drain() {
  if (running) return;
  running = true;
  try {
    while (pending.length) {
      const { id, settings, source } = pending.shift()!;
      try {
        if (!source) throw new Error('请先导入图片');
        const result = await pixelateAccelerated(source, settings);
        const response: WorkerResponse = { id, result };
        self.postMessage(response, [result.data.buffer]);
      } catch (error) {
        self.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse);
      }
    }
  } finally { running = false; }
}
