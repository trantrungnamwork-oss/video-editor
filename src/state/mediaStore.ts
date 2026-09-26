import { create } from 'zustand';
import { MediaProbeError, type MediaInfo, type MediaProbeErrorInfo } from '../media/probe';
import { createProbeClient, type ProbeClient } from '../media/probeClient';

interface MediaItemBase {
  id: string;
  file: File;
}

export type MediaItem =
  | (MediaItemBase & { status: 'probing' })
  | (MediaItemBase & { status: 'ready'; info: MediaInfo })
  | (MediaItemBase & { status: 'error'; error: MediaProbeErrorInfo });

export interface MediaState {
  items: MediaItem[];
  /** Clip shown in the preview. */
  selectedId: string | null;
  /** Adds files and starts probing them; returns the new item ids. */
  addFiles(files: Iterable<File>): string[];
  remove(id: string): void;
  select(id: string | null): void;
}

export function createMediaStore(getClient: () => ProbeClient) {
  return create<MediaState>()((set) => {
    const settle = (id: string, patch: MediaItem) =>
      set((s) => ({ items: s.items.map((it) => (it.id === id ? patch : it)) }));

    return {
      items: [],
      selectedId: null,
      addFiles(files) {
        const added: MediaItem[] = Array.from(files, (file) => ({
          id: crypto.randomUUID(),
          file,
          status: 'probing' as const,
        }));
        if (added.length === 0) return [];
        set((s) => ({ items: [...s.items, ...added] }));
        for (const { id, file } of added) {
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
        }
        return added.map((it) => it.id);
      },
      // A probe still in flight for a removed item settles into nothing: settle() only maps
      // existing ids.
      remove(id) {
        set((s) => ({
          items: s.items.filter((it) => it.id !== id),
          selectedId: s.selectedId === id ? null : s.selectedId,
        }));
      },
      select(id) {
        set({ selectedId: id });
      },
    };
  });
}

let client: ProbeClient | null = null;

export const useMediaStore = createMediaStore(() => (client ??= createProbeClient()));
