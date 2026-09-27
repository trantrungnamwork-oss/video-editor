import { create } from 'zustand';
import type { AspectRatio, ClipLayout } from '../core/frame';
import { commit, createHistory, redo, undo, type History } from '../core/history';
import {
  addClip,
  EMPTY_PROJECT,
  moveClip,
  removeClip,
  removeMedia,
  setAspect,
  setClipAudio,
  setClipLayout,
  splitAt,
  trimIn,
  trimOut,
  type ClipAudio,
  type MediaSource,
  type Project,
} from '../core/project';
import type { MediaInfo } from '../media/probe';
import { useMediaStore, type MediaItem } from './mediaStore';

export interface ProjectState {
  history: History<Project>;
  selectedClipId: string | null;
  select(clipId: string | null): void;
  addMedia(source: MediaSource): void;
  trimIn(clipId: string, inSec: number): void;
  trimOut(clipId: string, outSec: number): void;
  split(t: number): void;
  removeClip(clipId: string): void;
  moveClip(clipId: string, toIndex: number): void;
  setClipAudio(clipId: string, patch: Partial<ClipAudio>): void;
  setClipLayout(clipId: string, patch: Partial<ClipLayout>): void;
  setAspect(aspect: AspectRatio): void;
  removeMedia(mediaId: string): void;
  undo(): void;
  redo(): void;
  /** Moves cut points (e.g. onto keyframes) as one undoable edit. */
  setCuts(cuts: { clipId: string; inSec?: number; outSec?: number }[]): void;
  /** Replaces the project (e.g. restored after a reload); history starts fresh. */
  restore(project: Project): void;
}

export const mediaSourceOf = (id: string, info: MediaInfo): MediaSource => ({
  id,
  durationSec: info.durationSec,
  frameRate: info.video.frameRate,
});

export function createProjectStore() {
  return create<ProjectState>()((set, get) => {
    /** Applies an edit as one undo step; no-op edits leave history untouched. */
    const edit = (fn: (p: Project) => Project) =>
      set((s) => {
        const history = commit(s.history, fn(s.history.present));
        const ids = new Set(history.present.clips.map((c) => c.id));
        const selectedClipId =
          s.selectedClipId && ids.has(s.selectedClipId) ? s.selectedClipId : null;
        return { history, selectedClipId };
      });

    return {
      history: createHistory(EMPTY_PROJECT),
      selectedClipId: null,
      select: (selectedClipId) => set({ selectedClipId }),
      addMedia: (source) => edit((p) => addClip(p, source)),
      trimIn: (id, sec) => edit((p) => trimIn(p, id, sec)),
      trimOut: (id, sec) => edit((p) => trimOut(p, id, sec)),
      split: (t) => edit((p) => splitAt(p, t)),
      removeClip: (id) => edit((p) => removeClip(p, id)),
      moveClip: (id, to) => edit((p) => moveClip(p, id, to)),
      setClipAudio: (id, patch) => edit((p) => setClipAudio(p, id, patch)),
      setClipLayout: (id, patch) => edit((p) => setClipLayout(p, id, patch)),
      setAspect: (aspect) => edit((p) => setAspect(p, aspect)),
      removeMedia: (id) => edit((p) => removeMedia(p, id)),
      undo: () => {
        set((s) => ({ history: undo(s.history) }));
        get().select(validSelection(get()));
      },
      redo: () => {
        set((s) => ({ history: redo(s.history) }));
        get().select(validSelection(get()));
      },
      setCuts: (cuts) =>
        edit((p) =>
          cuts.reduce((q, c) => {
            let next = q;
            if (c.inSec !== undefined) next = trimIn(next, c.clipId, c.inSec);
            if (c.outSec !== undefined) next = trimOut(next, c.clipId, c.outSec);
            return next;
          }, p),
        ),
      restore: (project) => set({ history: createHistory(project), selectedClipId: null }),
    };
  });
}

function validSelection(s: ProjectState): string | null {
  const id = s.selectedClipId;
  return id && s.history.present.clips.some((c) => c.id === id) ? id : null;
}

export const useProjectStore = createProjectStore();

/**
 * Newly imported clips land on the timeline as soon as they are probed and decodable. Probes run
 * one at a time, so clips arrive in import order. Each media is added once; removing its clips
 * from the timeline later does not bring them back, and media the project already knows (restored
 * or relinked after a reload) is never added again.
 */
export function autoAddImportedMedia(
  media: typeof useMediaStore = useMediaStore,
  project: typeof useProjectStore = useProjectStore,
): () => void {
  const added = new Set<string>();
  const sync = (items: MediaItem[]) => {
    for (const it of items) {
      if (it.status !== 'ready' || !it.info.canDecode || added.has(it.id)) continue;
      added.add(it.id);
      if (it.id in project.getState().history.present.media) continue;
      project.getState().addMedia(mediaSourceOf(it.id, it.info));
    }
  };
  sync(media.getState().items);
  return media.subscribe((s) => sync(s.items));
}
