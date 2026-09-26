/**
 * Saves the project and the library's metadata so a reload (or the OS killing the tab) doesn't
 * lose the edit. Video files themselves can't be persisted from a file picker: after a reload
 * the library lists them as missing until the user selects them again (ADR 0007).
 *
 * The saved state is small JSON (clip ranges + probe results), so localStorage is enough.
 */
import type { Project } from '../core/project';
import { identityOf, type FileIdentity } from '../media/fileIdentity';
import type { MediaInfo } from '../media/probe';
import { useMediaStore } from './mediaStore';
import { useProjectStore } from './projectStore';

const STORAGE_KEY = 'video-editor:project';
const VERSION = 1;
const SAVE_DELAY_MS = 300;

interface Saved {
  version: typeof VERSION;
  media: { id: string; identity: FileIdentity; info: MediaInfo }[];
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
    if (it.status === 'ready') return [{ id: it.id, identity: identityOf(it.file), info: it.info }];
    if (it.status === 'missing') return [{ id: it.id, identity: it.identity, info: it.info }];
    return []; // probing/error items have nothing worth restoring yet
  });
  return { version: VERSION, media, project: useProjectStore.getState().history.present };
}

/** Restores the saved state (if any) into the stores. Call before anything else subscribes. */
export function restoreSaved(storage: Storage = localStorage): boolean {
  const saved = loadSaved(storage);
  if (!saved || (saved.media.length === 0 && saved.project.clips.length === 0)) return false;
  useMediaStore.getState().restoreMissing(saved.media);
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
