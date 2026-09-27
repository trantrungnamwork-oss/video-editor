import type { Thumbnail, ThumbnailRequest } from './thumbnails';

type Response =
  { id: number; ok: true; thumbs: Thumbnail[] } | { id: number; ok: false; message: string };

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (t: Thumbnail[]) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/thumbnail.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (e: MessageEvent<Response>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.thumbs);
    else p.reject(new Error(e.data.message));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Thumbnail worker crashed'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Generates (or loads from the OPFS cache) a thumbnail strip for a clip. */
export function requestThumbnails(file: File, req: ThumbnailRequest): Promise<Thumbnail[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, file, ...req });
  });
}
