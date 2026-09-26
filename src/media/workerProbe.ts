import type { ProbeResult, WorkerProbeResult } from './capabilities';

// Kept separate from capabilities.ts so the worker bundle does not import the module that
// spawns it (avoids a circular worker graph in Vite).

interface SyncAccessHandleLike {
  write(buffer: ArrayBufferView): number;
  flush(): void;
  close(): void;
}

const presence = (present: boolean): ProbeResult =>
  present ? { status: 'supported' } : { status: 'no-api' };

/** Runs inside a dedicated worker: the only scope where OPFS sync access handles exist. */
export async function probeInWorker(scope: typeof globalThis): Promise<WorkerProbeResult> {
  const s = scope as typeof globalThis & Record<string, unknown>;
  const offscreenCanvas = presence(typeof s['OffscreenCanvas'] === 'function');
  const webCodecs = presence(
    typeof s['VideoDecoder'] === 'function' && typeof s['VideoEncoder'] === 'function',
  );
  return {
    opfsSyncAccessHandle: await probeSyncAccessHandle(s.navigator),
    offscreenCanvas,
    webCodecs,
  };
}

async function probeSyncAccessHandle(nav: Navigator | undefined): Promise<ProbeResult> {
  const storage = nav?.storage;
  if (!storage || typeof storage.getDirectory !== 'function') return { status: 'no-api' };
  const name = `.capability-probe-${Math.random().toString(36).slice(2)}`;
  try {
    const root = await storage.getDirectory();
    try {
      const file = (await root.getFileHandle(name, { create: true })) as FileSystemFileHandle & {
        createSyncAccessHandle?: () => Promise<SyncAccessHandleLike>;
      };
      if (typeof file.createSyncAccessHandle !== 'function') return { status: 'no-api' };
      const handle = await file.createSyncAccessHandle();
      try {
        handle.write(new Uint8Array([1, 2, 3, 4]));
        handle.flush();
      } finally {
        handle.close();
      }
      return { status: 'supported' };
    } finally {
      await root.removeEntry(name).catch(() => undefined);
    }
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
