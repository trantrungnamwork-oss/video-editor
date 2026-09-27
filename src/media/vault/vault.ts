/**
 * The app's own copy of imported videos, in OPFS (ADR 0011, TL-009). A picked `File` is only a
 * handle to the user's file, which the browser forgets on reload and Android may stop letting us
 * read; the copy survives both. Copies are skipped when storage is short, and the video then
 * behaves as before (select it again after a reload).
 */
import { identityOf, type FileIdentity } from '../fileIdentity';
import { VAULT_DIR, type FromVault } from './protocol';

export { VAULT_DIR };
/** Space left free for exports and the browser after a copy. */
export const RESERVE_BYTES = 512 * 1024 * 1024;

export type StoreResult = { stored: File } | { skipped: string };

export interface VaultClient {
  /** Copies `file`; resolves with the stored copy (same name, type and date as the original). */
  store(id: string, file: File, onProgress: (fraction: number) => void): Promise<StoreResult>;
  /** Stops a copy in progress (if any) and deletes the stored copy. */
  remove(id: string): Promise<void>;
  /** The stored copy of a video, or null when there is none (or it is incomplete). */
  load(id: string, identity: FileIdentity): Promise<File | null>;
  /** Deletes stored copies of every id not in `keep`. */
  prune(keep: ReadonlySet<string>): Promise<void>;
}

/** Wraps the OPFS file so it carries the original's identity (relink, export resume, UI). */
const asOriginal = (stored: Blob, identity: FileIdentity, type: string) =>
  new File([stored], identity.name, { type, lastModified: identity.lastModified });

async function vaultDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(VAULT_DIR, { create: true });
  } catch {
    return null; // no OPFS (e.g. some private modes)
  }
}

async function entries(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const out: string[] = [];
  const it = (dir as unknown as { keys(): AsyncIterable<string> }).keys();
  for await (const n of it) out.push(n);
  return out;
}

export async function hasRoomFor(bytes: number): Promise<boolean> {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota === undefined || usage === undefined) return false;
    return quota - usage - bytes >= RESERVE_BYTES;
  } catch {
    return false;
  }
}

export function createVaultClient(): VaultClient {
  let worker: Worker | null = null;
  const pending = new Map<
    string,
    { resolve: (r: StoreResult) => void; onProgress: (f: number) => void; file: File }
  >();
  let persistAsked = false;

  const getWorker = () => {
    if (!worker) {
      worker = new Worker(new URL('../../workers/vault.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (e: MessageEvent<FromVault>) => {
        const m = e.data;
        const p = pending.get(m.id);
        if (!p) return;
        if (m.type === 'progress') return p.onProgress(m.fraction);
        pending.delete(m.id);
        if (m.type === 'done') {
          p.resolve(
            m.file.size === p.file.size
              ? { stored: asOriginal(m.file, identityOf(p.file), p.file.type) }
              : { skipped: 'The copy is incomplete' },
          );
        } else if (m.type === 'cancelled') p.resolve({ skipped: 'Removed' });
        else p.resolve({ skipped: `Could not copy the video (${m.message})` });
      };
    }
    return worker;
  };

  return {
    async store(id, file, onProgress) {
      if (!(await hasRoomFor(file.size))) {
        return { skipped: 'Not enough free storage on this device' };
      }
      if (!persistAsked) {
        persistAsked = true;
        // Ask the browser not to evict the copies under storage pressure (best effort).
        await navigator.storage.persist?.().catch(() => false);
      }
      return new Promise<StoreResult>((resolve) => {
        pending.set(id, { resolve, onProgress, file });
        getWorker().postMessage({ type: 'store', id, file });
      });
    },
    async remove(id) {
      if (pending.has(id)) {
        getWorker().postMessage({ type: 'cancel', id });
        return; // the worker deletes the partial copy
      }
      const dir = await vaultDir();
      await dir?.removeEntry(id).catch(() => undefined);
    },
    async load(id, identity) {
      const dir = await vaultDir();
      if (!dir) return null;
      try {
        const stored = await (await dir.getFileHandle(id)).getFile();
        if (stored.size !== identity.size) return null;
        return asOriginal(stored, identity, typeFor(identity.name));
      } catch {
        return null;
      }
    },
    async prune(keep) {
      const dir = await vaultDir();
      if (!dir) return;
      for (const name of await entries(dir)) {
        if (!keep.has(name) && !pending.has(name))
          await dir.removeEntry(name).catch(() => undefined);
      }
    },
  };
}

/** MIME type from the extension; the saved identity has no type. */
function typeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    ts: 'video/mp2t',
    mts: 'video/mp2t',
    m2ts: 'video/mp2t',
  };
  return (ext && types[ext]) ?? '';
}
