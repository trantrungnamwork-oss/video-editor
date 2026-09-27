import type { TestClipSpec } from './testClip';

type Response = { ok: true; file: File } | { ok: false; message: string };

/** Encodes a test clip in a throwaway worker (keeps Mediabunny's encoder out of the main bundle). */
export function requestTestClip(spec: TestClipSpec): Promise<File> {
  const worker = new Worker(new URL('../workers/testClip.worker.ts', import.meta.url), {
    type: 'module',
  });
  return new Promise<File>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<Response>) => {
      if (e.data.ok) resolve(e.data.file);
      else reject(new Error(e.data.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Test clip worker failed'));
    worker.postMessage(spec);
  }).finally(() => worker.terminate());
}
