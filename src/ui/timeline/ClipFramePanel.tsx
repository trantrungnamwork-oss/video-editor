import { useState } from 'react';
import type { ClipLayout } from '../../core/frame';
import { layoutOf, type Clip } from '../../core/project';
import { useProjectStore } from '../../state/projectStore';

/**
 * How the selected clip sits in the frame: whole picture (Fit, bars where the shapes differ) or
 * filling the frame (Fill, cropped), with sliders choosing which part stays visible. Sliders
 * commit on release, like the audio panel.
 */
export function ClipFramePanel({ clip }: { clip: Clip }) {
  const project = useProjectStore((s) => s.history.present);
  const saved = layoutOf(project, clip);
  const [draft, setDraft] = useState<{ clipId: string; layout: ClipLayout } | null>(null);
  const current = draft?.clipId === clip.id ? draft.layout : saved;
  const commit = (patch?: Partial<ClipLayout>) => {
    useProjectStore.getState().setClipLayout(clip.id, { ...current, ...patch });
    setDraft(null);
  };
  const pan = (axis: 'panX' | 'panY', label: string) => (
    <label className="flex flex-col text-sm">
      <span className="text-neutral-400">{label}</span>
      <input
        type="range"
        className="h-11 w-full accent-yellow-400"
        aria-label={label}
        min={-1}
        max={1}
        step={0.05}
        value={current[axis]}
        onChange={(e) =>
          setDraft({ clipId: clip.id, layout: { ...current, [axis]: Number(e.target.value) } })
        }
        onPointerUp={() => commit()}
        onKeyUp={() => commit()}
        onBlur={() => draft && commit()}
      />
    </label>
  );
  const fitButton = (fit: ClipLayout['fit'], label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={current.fit === fit}
      onClick={() => commit({ fit })}
      className={`min-h-11 flex-1 rounded-lg px-3 text-sm font-medium ${
        current.fit === fit ? 'bg-yellow-400 text-black' : 'bg-neutral-800 active:bg-neutral-700'
      }`}
    >
      {label}
    </button>
  );

  return (
    <fieldset
      className="mt-2 grid gap-x-4 gap-y-1 rounded-lg bg-neutral-900 p-3 sm:grid-cols-[auto_1fr_1fr]"
      data-testid="clip-frame-panel"
    >
      <legend className="sr-only">Clip framing</legend>
      <div role="radiogroup" aria-label="Clip framing" className="flex gap-2 self-end">
        {fitButton('contain', 'Fit')}
        {fitButton('cover', 'Fill')}
      </div>
      {current.fit === 'cover' && (
        <>
          {pan('panX', 'Horizontal position')}
          {pan('panY', 'Vertical position')}
        </>
      )}
    </fieldset>
  );
}
