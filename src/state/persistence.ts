/**
 * Saves the project and the library's metadata so a reload (or the OS killing the tab) doesn't
 * lose the edit. Picked files themselves can't be persisted, so videos are also copied into OPFS
 * (ADR 0011) and reopened from there; a video without a copy (no space) is listed as missing
 * until the user selects it again (ADR 0007).
 *
 * The saved state is small JSON (clip ranges + probe results), so localStorage is enough.
 */
import type { Project } from '../core/project';
import { identityOf, type FileIdentity } from '../media/fileIdentity';
import type { MediaInfo } from '../media/probe';
import { getVault, useMediaStore, type MediaItem } from './mediaStore';
import { useProjectStore } from './projectStore';

const STORAGE_KEY = 'video-editor:project';
const VERSION = 1;
const SAVE_DELAY_MS = 300;

interface Saved {
  version: typeof VERSION;
  /** `stored`: the app holds its own copy of the video (ADR 0011). */
  media: { id: string; identity: FileIdentity; info: MediaInfo; stored?: boolean }[];
  project: Project;
}

export function loadSaved(storage: Storage = localStorage): Saved | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Saved;
    return saved.version === VERSION ? saved : null;
  } catch {
    return null;
  }
}

function snapshot(): Saved {
  const media = useMediaStore.getState().items.flatMap((it) => {
    if (it.status === 'ready') {
      const stored = it.vault?.state === 'stored';
      return [
        { id: it.id, identity: identityOf(it.file), info: it.info, ...(stored ? { stored } : {}) },
      ];
    }
    if (it.status === 'missing') return [{ id: it.id, identity: it.identity, info: it.info }];
    return []; // probing/error items have nothing worth restoring yet
  });
  return { version: VERSION, media, project: useProjectStore.getState().history.present };
}

/**
 * Restores the saved state (if any) into the stores, reopening stored copies of the videos, and
 * deletes copies nothing refers to. Call before anything else subscribes.
 */
export async function restoreSaved(storage: Storage = localStorage): Promise<boolean> {
  const saved = loadSaved(storage);
  const vault = getVault();
  const media = saved?.media ?? [];
  const items = await Promise.all(
    media.map(async (m): Promise<MediaItem> => {
      const file = m.stored && vault ? await vault.load(m.id, m.identity) : null;
      return file
        ? { id: m.id, file, status: 'ready', info: m.info, vault: { state: 'stored' } }
        : { id: m.id, status: 'missing', identity: m.identity, info: m.info };
    }),
  );
  await vault
    ?.prune(new Set(items.filter((it) => it.status === 'ready').map((it) => it.id)))
    .catch(() => undefined);
  if (!saved || (media.length === 0 && saved.project.clips.length === 0)) return false;
  useMediaStore.getState().restore(items);
  useProjectStore.getState().restore(saved.project);
  return true;
}

/** Saves on every change (debounced). Returns an unsubscribe function. */
export function persistChanges(storage: Storage = localStorage): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(snapshot()));
      } catch (err) {
        console.warn('[persistence] could not save project', err);
      }
    }, SAVE_DELAY_MS);
  };
  const offMedia = useMediaStore.subscribe(save);
  const offProject = useProjectStore.subscribe(save);
  const flush = () => {
    clearTimeout(timer);
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(snapshot()));
    } catch {
      // best effort on unload
    }
  };
  window.addEventListener('pagehide', flush);
  return () => {
    offMedia();
    offProject();
    window.removeEventListener('pagehide', flush);
    clearTimeout(timer);
  };
}
