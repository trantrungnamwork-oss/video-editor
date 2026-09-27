import { MediaProbeError, type MediaInfo, type MediaProbeErrorInfo } from './probe';

export interface ProbeRequest {
  id: number;
  file: File;
}

export type ProbeResponse =
  { id: number; ok: true; info: MediaInfo } | { id: number; ok: false; error: MediaProbeErrorInfo };

export interface ProbeClient {
  probe(file: File): Promise<MediaInfo>;
  dispose(): void;
}

/**
 * Runs probes in a dedicated worker so demuxing (e.g. parsing a large moov box) never blocks the
 * main thread. `File` is structured-cloned by reference; no file bytes are copied.
 */
export function createProbeClient(): ProbeClient {
  let worker: Worker | null = null;
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (info: MediaInfo) => void; reject: (err: Error) => void }
  >();

  const failAll = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
  };

  const getWorker = () => {
    if (worker) return worker;
    worker = new Worker(new URL('../workers/probe.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<ProbeResponse>) => {
      const res = e.data;
      const p = pending.get(res.id);
      if (!p) return;
      pending.delete(res.id);
      if (res.ok) p.resolve(res.info);
      else p.reject(new MediaProbeError(res.error.code, res.error.message));
    };
    worker.onerror = (e) => {
      failAll(new MediaProbeError('read-failed', e.message || 'Probe worker crashed'));
    };
    return worker;
  };

  return {
    probe(file) {
      const id = nextId++;
      return new Promise<MediaInfo>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        getWorker().postMessage({ id, file } satisfies ProbeRequest);
      });
    },
    dispose() {
      failAll(new Error('Probe client disposed'));
    },
  };
}
