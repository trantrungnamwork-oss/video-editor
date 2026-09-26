import type { StreamTargetChunk } from 'mediabunny';

/** Worker-only: sync access handles do not exist on the main thread. */
interface SyncHandle {
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

const EXPORT_DIR = 'exports';

export async function exportDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(EXPORT_DIR, { create: true });
}

/** Deletes previous exports (keeps OPFS usage to one output file at a time). */
export async function clearExports(except?: string): Promise<void> {
  const dir = await exportDir();
  const names: string[] = [];
  const entries = (dir as unknown as { keys(): AsyncIterable<string> }).keys();
  for await (const name of entries) if (name !== except) names.push(name);
  for (const name of names) await dir.removeEntry(name).catch(() => undefined);
}

/**
 * A WritableStream for Mediabunny's StreamTarget that writes each chunk at its position in an
 * OPFS file (MP4 muxing patches earlier bytes, so writes are not strictly sequential).
 */
export async function openOpfsWriter(name: string) {
  const dir = await exportDir();
  const fileHandle = (await dir.getFileHandle(name, { create: true })) as FileSystemFileHandle & {
    createSyncAccessHandle(): Promise<SyncHandle>;
  };
  const handle = await fileHandle.createSyncAccessHandle();
  handle.truncate(0);
  let bytesWritten = 0;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    handle.flush();
    handle.close();
  };
  const stream = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      handle.write(chunk.data, { at: chunk.position });
      bytesWritten = Math.max(bytesWritten, chunk.position + chunk.data.byteLength);
    },
    close,
    abort: close,
  });
  return {
    stream,
    get bytesWritten() {
      return bytesWritten;
    },
    close,
    file: async () => {
      close();
      return fileHandle.getFile();
    },
    remove: async () => {
      close();
      await dir.removeEntry(name).catch(() => undefined);
    },
  };
}
