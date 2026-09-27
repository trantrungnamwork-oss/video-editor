/// <reference lib="webworker" />
/**
 * Copies imported videos into OPFS (`media/<id>`), one at a time, streaming so a large file never
 * sits in memory. Sync access handles are worker-only and the fastest way to write OPFS.
 */
import { VAULT_DIR, type FromVault, type ToVault } from '../media/vault/protocol';

interface SyncHandle {
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

const PROGRESS_INTERVAL_MS = 250;
const queue: { id: string; file: File }[] = [];
const cancelled = new Set<string>();
let busy = false;

const post = (m: FromVault) => self.postMessage(m);

self.onmessage = (e: MessageEvent<ToVault>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    const i = queue.findIndex((q) => q.id === msg.id);
    if (i >= 0) {
      queue.splice(i, 1);
      cancelled.delete(msg.id);
      post({ type: 'cancelled', id: msg.id });
    }
    return;
  }
  queue.push({ id: msg.id, file: msg.file });
  void drain();
};

async function drain() {
  if (busy) return;
  busy = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) await copy(job.id, job.file);
  } finally {
    busy = false;
  }
}

async function copy(id: string, file: File) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(VAULT_DIR, { create: true });
  const fh = (await dir.getFileHandle(id, { create: true })) as FileSystemFileHandle & {
    createSyncAccessHandle(): Promise<SyncHandle>;
  };
  let handle: SyncHandle | null = null;
  let ok = false;
  try {
    handle = await fh.createSyncAccessHandle();
    handle.truncate(0);
    const reader = file.stream().getReader();
    let at = 0;
    let lastPost = 0;
    for (;;) {
      if (cancelled.has(id)) {
        await reader.cancel();
        break;
      }
      const { done, value } = await reader.read();
      if (done) {
        ok = true;
        break;
      }
      handle.write(value, { at });
      at += value.byteLength;
      const now = performance.now();
      if (now - lastPost > PROGRESS_INTERVAL_MS) {
        lastPost = now;
        post({ type: 'progress', id, fraction: file.size > 0 ? at / file.size : 1 });
      }
    }
    handle.flush();
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  } finally {
    handle?.close();
  }
  if (ok && !cancelled.has(id)) {
    post({ type: 'done', id, file: await fh.getFile() });
    return;
  }
  await dir.removeEntry(id).catch(() => undefined);
  if (cancelled.delete(id)) post({ type: 'cancelled', id });
}
