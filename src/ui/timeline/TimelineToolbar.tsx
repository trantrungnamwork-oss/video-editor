import { useEffect, type ReactNode } from 'react';
import { locate } from '../../core/project';
import type { PreviewPlayer } from '../../media/preview/previewPlayer';
import { useProjectStore } from '../../state/projectStore';

const BTN =
  'flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg bg-neutral-800 px-3 text-sm font-medium active:bg-neutral-700 disabled:opacity-40';

/** Edit actions. Split acts at the playhead; delete/move act on the selected clip. */
export function TimelineToolbar({
  player,
  extra,
}: {
  player: PreviewPlayer | null;
  extra?: ReactNode;
}) {
  const history = useProjectStore((s) => s.history);
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const project = history.present;
  const selectedIndex = project.clips.findIndex((c) => c.id === selectedClipId);
  const hasSelection = selectedIndex >= 0;

  const actions = {
    undo: () => useProjectStore.getState().undo(),
    redo: () => useProjectStore.getState().redo(),
    split: () => {
      if (!player) return;
      if (player.state.playing) player.pause();
      const t = player.currentTime;
      const s = useProjectStore.getState();
      s.split(t);
      // Select the piece left of the cut, like most editors.
      const hit = locate(s.history.present, Math.max(0, t - 1e-3));
      if (hit) useProjectStore.getState().select(hit.clip.id);
    },
    remove: () => {
      const id = useProjectStore.getState().selectedClipId;
      if (id) useProjectStore.getState().removeClip(id);
    },
    move: (delta: -1 | 1) => {
      const id = useProjectStore.getState().selectedClipId;
      if (id) useProjectStore.getState().moveClip(id, selectedIndex + delta);
    },
  };

  // Re-bound every render so shortcuts always see current state; cheap (one listener).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) useProjectStore.getState().redo();
        else useProjectStore.getState().undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        useProjectStore.getState().redo();
      } else if (!mod && e.key.toLowerCase() === 's') {
        actions.split();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        actions.remove();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="timeline-toolbar">
      <button
        type="button"
        className={BTN}
        onClick={actions.undo}
        disabled={history.past.length === 0}
        aria-label="Undo"
      >
        ↶
      </button>
      <button
        type="button"
        className={BTN}
        onClick={actions.redo}
        disabled={history.future.length === 0}
        aria-label="Redo"
      >
        ↷
      </button>
      <button
        type="button"
        className={BTN}
        onClick={actions.split}
        disabled={!player || project.clips.length === 0}
        aria-label="Split at playhead"
      >
        ✂︎ Split
      </button>
      <button
        type="button"
        className={BTN}
        onClick={actions.remove}
        disabled={!hasSelection}
        aria-label="Delete clip"
      >
        Delete
      </button>
      <button
        type="button"
        className={BTN}
        onClick={() => actions.move(-1)}
        disabled={!hasSelection || selectedIndex === 0}
        aria-label="Move clip left"
      >
        ←
      </button>
      <button
        type="button"
        className={BTN}
        onClick={() => actions.move(1)}
        disabled={!hasSelection || selectedIndex === project.clips.length - 1}
        aria-label="Move clip right"
      >
        →
      </button>
      {extra}
    </div>
  );
}
