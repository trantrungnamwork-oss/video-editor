import { BUILTIN_TRACKS } from './builtinMusic';

/** A built-in track as a WAV file (rendered in a worker; the vault then keeps a copy). */
export function builtinTrackFile(id: string): Promise<File> {
  const track = BUILTIN_TRACKS.find((t) => t.id === id);
  const worker = new Worker(new URL('../../workers/music.worker.ts', import.meta.url), {
    type: 'module',
  });
  return new Promise<File>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<{ ok: boolean; bytes?: Uint8Array; error?: string }>) => {
      worker.terminate();
      if (e.data.ok && e.data.bytes) {
        // Fixed date: picking the same track twice is recognised as the same file.
        resolve(
          new File([e.data.bytes as BlobPart], `${track?.name ?? id} (built-in).wav`, {
            type: 'audio/wav',
            lastModified: 0,
          }),
        );
      } else reject(new Error(e.data.error ?? 'Could not render the track'));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ id });
  });
}
