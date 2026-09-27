import { create } from 'zustand';
import type { AspectRatio, ClipLayout, Fit } from '../core/frame';
import {
  addAudioItem,
  moveAudioItem,
  removeAudioItem,
  setAudioItemAudio,
  setAudioItemLength,
  setDuck,
} from '../core/audioTrack';
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
  setProjectFit,
  splitAt,
  trimIn,
  trimOut,
  type AudioKind,
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
  /** Selected music/voice item (clip and audio selections exclude each other). */
  selectedAudioId: string | null;
  selectAudio(id: string | null): void;
  addAudio(source: MediaSource, kind: AudioKind, startSec: number): void;
  moveAudio(id: string, startSec: number): void;
  setAudioLength(id: string, patch: { durationSec?: number | null; loop?: boolean }): void;
  setAudioSettings(id: string, patch: Partial<ClipAudio>): void;
  removeAudio(id: string): void;
  setDuck(on: boolean): void;
  addMedia(source: MediaSource): void;
  trimIn(clipId: string, inSec: number): void;
  trimOut(clipId: string, outSec: number): void;
  split(t: number): void;
  removeClip(clipId: string): void;
  moveClip(clipId: string, toIndex: number): void;
  setClipAudio(clipId: string, patch: Partial<ClipAudio>): void;
  setClipLayout(clipId: string, patch: Partial<ClipLayout>): void;
  setAspect(aspect: AspectRatio): void;
  setProjectFit(fit: Fit): void;
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
  frameRate: info.video?.frameRate ?? null,
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
        const selectedAudioId =
          s.selectedAudioId && history.present.audioItems?.some((a) => a.id === s.selectedAudioId)
            ? s.selectedAudioId
            : null;
        return { history, selectedClipId, selectedAudioId };
      });

    return {
      history: createHistory(EMPTY_PROJECT),
      selectedClipId: null,
      selectedAudioId: null,
      select: (selectedClipId) =>
        set(selectedClipId ? { selectedClipId, selectedAudioId: null } : { selectedClipId }),
      selectAudio: (selectedAudioId) =>
        set(selectedAudioId ? { selectedAudioId, selectedClipId: null } : { selectedAudioId }),
      addAudio: (source, kind, startSec) => edit((p) => addAudioItem(p, source, kind, startSec)),
      moveAudio: (id, startSec) => edit((p) => moveAudioItem(p, id, startSec)),
      setAudioLength: (id, patch) => edit((p) => setAudioItemLength(p, id, patch)),
      setAudioSettings: (id, patch) => edit((p) => setAudioItemAudio(p, id, patch)),
      removeAudio: (id) => edit((p) => removeAudioItem(p, id)),
      setDuck: (on) => edit((p) => setDuck(p, on)),
      addMedia: (source) => edit((p) => addClip(p, source)),
      trimIn: (id, sec) => edit((p) => trimIn(p, id, sec)),
      trimOut: (id, sec) => edit((p) => trimOut(p, id, sec)),
      split: (t) => edit((p) => splitAt(p, t)),
      removeClip: (id) => edit((p) => removeClip(p, id)),
      moveClip: (id, to) => edit((p) => moveClip(p, id, to)),
      setClipAudio: (id, patch) => edit((p) => setClipAudio(p, id, patch)),
      setClipLayout: (id, patch) => edit((p) => setClipLayout(p, id, patch)),
      setAspect: (aspect) => edit((p) => setAspect(p, aspect)),
      setProjectFit: (fit) => edit((p) => setProjectFit(p, fit)),
      removeMedia: (id) => edit((p) => removeMedia(p, id)),
      undo: () => {
        set((s) => ({ history: undo(s.history) }));
        set(validSelection(get()));
      },
      redo: () => {
        set((s) => ({ history: redo(s.history) }));
        set(validSelection(get()));
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
      restore: (project) =>
        set({ history: createHistory(project), selectedClipId: null, selectedAudioId: null }),
    };
  });
}

function validSelection(s: ProjectState) {
  const p = s.history.present;
  const c = s.selectedClipId;
  const a = s.selectedAudioId;
  return {
    selectedClipId: c && p.clips.some((x) => x.id === c) ? c : null,
    selectedAudioId: a && p.audioItems?.some((x) => x.id === a) ? a : null,
  };
}

/** Where audio files picked for the music/voice rows go once probed (media id → placement). */
const pendingAudio = new Map<string, { kind: AudioKind; startSec: number }>();
export function placeAudioWhenReady(ids: string[], kind: AudioKind, startSec: number) {
  for (const id of ids) pendingAudio.set(id, { kind, startSec });
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
      const placement = pendingAudio.get(it.id);
      if (it.info.kind === 'audio') {
        // Audio files go on the music/voice rows, and only when picked for them.
        if (!placement) continue;
        added.add(it.id);
        pendingAudio.delete(it.id);
        const s = project.getState();
        s.addAudio(mediaSourceOf(it.id, it.info), placement.kind, placement.startSec);
        continue;
      }
      added.add(it.id);
      if (it.id in project.getState().history.present.media) continue;
      project.getState().addMedia(mediaSourceOf(it.id, it.info));
    }
  };
  sync(media.getState().items);
  return media.subscribe((s) => sync(s.items));
}
