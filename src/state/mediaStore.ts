import { create } from 'zustand';
import { identityOf, sameFile, type FileIdentity } from '../media/fileIdentity';
import { MediaProbeError, type MediaInfo, type MediaProbeErrorInfo } from '../media/probe';
import { createProbeClient, type ProbeClient } from '../media/probeClient';

interface MediaItemBase {
  id: string;
  file: File;
}

export type MediaItem =
  | (MediaItemBase & { status: 'probing' })
  | (MediaItemBase & { status: 'ready'; info: MediaInfo })
  | (MediaItemBase & { status: 'error'; error: MediaProbeErrorInfo })
  /** Restored after a reload: known from the saved project, waiting for the user to re-select it. */
  | { id: string; status: 'missing'; identity: FileIdentity; info: MediaInfo };

export interface MediaState {
  items: MediaItem[];
  /**
   * Adds files and starts probing them; returns the item ids. A file matching a missing item
   * (same name, size and modification time) relinks that item and keeps its id.
   */
  addFiles(files: Iterable<File>): string[];
  remove(id: string): void;
  /** Replaces the library with saved items awaiting relink. */
  restoreMissing(items: { id: string; identity: FileIdentity; info: MediaInfo }[]): void;
}

export const itemName = (it: MediaItem) =>
  it.status === 'missing' ? it.identity.name : it.file.name;
export const itemSize = (it: MediaItem) =>
  it.status === 'missing' ? it.identity.size : it.file.size;

export function createMediaStore(getClient: () => ProbeClient) {
  return create<MediaState>()((set, get) => {
    const settle = (id: string, patch: MediaItem) =>
      set((s) => ({ items: s.items.map((it) => (it.id === id ? patch : it)) }));

    const probe = (id: string, file: File) => {
      getClient()
        .probe(file)
        .then(
          (info) => settle(id, { id, file, status: 'ready', info }),
          (err: unknown) =>
            settle(id, {
              id,
              file,
              status: 'error',
              error:
                err instanceof MediaProbeError
                  ? { code: err.code, message: err.message }
                  : { code: 'read-failed', message: String(err) },
            }),
        );
    };

    return {
      items: [],
      addFiles(files) {
        const ids: string[] = [];
        const relinked = new Map<string, File>();
        const refreshed = new Map<string, File>();
        const added: MediaItem[] = [];
        for (const file of files) {
          // Picking a file already in the library renews its handle (the browser may have lost
          // read access to the old one, TL-009) instead of adding a duplicate.
          const known = get().items.find(
            (it) =>
              it.status === 'ready' &&
              !refreshed.has(it.id) &&
              sameFile(identityOf(it.file), identityOf(file)),
          );
          if (known) {
            refreshed.set(known.id, file);
            ids.push(known.id);
            continue;
          }
          const missing = get().items.find(
            (it) =>
              it.status === 'missing' &&
              !relinked.has(it.id) &&
              sameFile(it.identity, identityOf(file)),
          );
          if (missing) {
            relinked.set(missing.id, file);
            ids.push(missing.id);
          } else {
            const item: MediaItem = { id: crypto.randomUUID(), file, status: 'probing' };
            added.push(item);
            ids.push(item.id);
          }
        }
        if (ids.length === 0) return [];
        set((s) => ({
          items: [
            ...s.items.map((it): MediaItem => {
              const file = relinked.get(it.id);
              if (file) return { id: it.id, file, status: 'probing' };
              const renewed = refreshed.get(it.id);
              return renewed && it.status === 'ready' ? { ...it, file: renewed } : it;
            }),
            ...added,
          ],
        }));
        for (const [id, file] of relinked) probe(id, file);
        for (const it of added) if (it.status === 'probing') probe(it.id, it.file);
        return ids;
      },
      // A probe still in flight for a removed item settles into nothing: settle() only maps
      // existing ids.
      remove(id) {
        set((s) => ({ items: s.items.filter((it) => it.id !== id) }));
      },
      restoreMissing(items) {
        set({ items: items.map((it) => ({ ...it, status: 'missing' as const })) });
      },
    };
  });
}

let client: ProbeClient | null = null;

export const useMediaStore = createMediaStore(() => (client ??= createProbeClient()));
