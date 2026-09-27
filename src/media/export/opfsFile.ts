import type { StreamTargetChunk } from 'mediabunny';
import type { Checkpoint, JobStore } from './exportPipeline';

/** Worker-only: sync access handles do not exist on the main thread. */
interface SyncHandle {
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

const EXPORT_DIR = 'exports';
const JOB_DIR = 'job';
const CHECKPOINT = 'checkpoint.json';

export async function exportDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(EXPORT_DIR, { create: true });
}

async function names(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const out: string[] = [];
  const it = (dir as unknown as { keys(): AsyncIterable<string> }).keys();
  for await (const n of it) out.push(n);
  return out;
}

/** Deletes finished exports (keeps OPFS usage to one output file). Never touches the job dir. */
export async function clearFinishedExports(): Promise<void> {
  const dir = await exportDir();
  for (const n of await names(dir)) {
    if (n !== JOB_DIR) await dir.removeEntry(n).catch(() => undefined);
  }
}

/**
 * A WritableStream for Mediabunny's StreamTarget that writes each chunk at its position in an
 * OPFS file (MP4 muxing patches earlier bytes, so writes are not strictly sequential).
 */
export async function openOpfsWriter(dir: FileSystemDirectoryHandle, name: string) {
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

/** The resumable job's files: checkpoint, audio and video segments (worker only for writes). */
export async function openJobStore(): Promise<JobStore> {
  const parent = await exportDir();
  let dir = await parent.getDirectoryHandle(JOB_DIR, { create: true });
  return {
    readCheckpoint: () => readCheckpointIn(dir),
    async writeCheckpoint(c: Checkpoint) {
      const w = await openOpfsWriter(dir, CHECKPOINT);
      const bytes = new TextEncoder().encode(JSON.stringify(c));
      const writer = w.stream.getWriter();
      await writer.write({ type: 'write', data: bytes, position: 0 });
      await writer.close();
    },
    writer: (name) => openOpfsWriter(dir, name),
    async file(name) {
      return (await dir.getFileHandle(name)).getFile();
    },
    async clear() {
      await parent.removeEntry(JOB_DIR, { recursive: true }).catch(() => undefined);
      dir = await parent.getDirectoryHandle(JOB_DIR, { create: true });
    },
  };
}

async function readCheckpointIn(dir: FileSystemDirectoryHandle): Promise<Checkpoint | null> {
  try {
    const text = await (await (await dir.getFileHandle(CHECKPOINT)).getFile()).text();
    return JSON.parse(text) as Checkpoint;
  } catch {
    return null;
  }
}

/** Main-thread read of an unfinished export's checkpoint (e.g. after the tab was killed). */
export async function readPendingCheckpoint(): Promise<Checkpoint | null> {
  try {
    const parent = await exportDir();
    return readCheckpointIn(await parent.getDirectoryHandle(JOB_DIR));
  } catch {
    return null;
  }
}

/** Main-thread discard of an unfinished export. */
export async function discardPendingExport(): Promise<void> {
  const parent = await exportDir();
  await parent.removeEntry(JOB_DIR, { recursive: true }).catch(() => undefined);
}
