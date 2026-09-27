import { useState, type ReactNode } from 'react';
import { audioOf, clipDuration, MAX_VOLUME, type Clip, type ClipAudio } from '../../core/project';
import { useMediaStore } from '../../state/mediaStore';
import { useProjectStore } from '../../state/projectStore';

/** Longest fade offered by the sliders (the model allows up to the clip length). */
const MAX_FADE_SEC = 5;

/**
 * Audio settings of the selected clip. Sliders edit a local draft and commit on release, so a
 * drag is one undo step and the preview restarts once, not on every pixel.
 */
export function ClipAudioPanel({ clip }: { clip: Clip }) {
  const hasAudio = useMediaStore((s) => {
    const it = s.items.find((i) => i.id === clip.mediaId);
    return !!it && it.status !== 'error' && it.status !== 'probing' && !!it.info.audio;
  });
  const saved = audioOf(clip);
  const [draft, setDraft] = useState<{ clipId: string; audio: ClipAudio } | null>(null);
  const current = draft?.clipId === clip.id ? draft.audio : saved;
  const maxFade = Math.min(MAX_FADE_SEC, Math.floor(clipDuration(clip) * 10) / 10);

  const change = (patch: Partial<ClipAudio>) =>
    setDraft({ clipId: clip.id, audio: { ...current, ...patch } });
  const commit = (patch?: Partial<ClipAudio>) => {
    useProjectStore.getState().setClipAudio(clip.id, { ...current, ...patch });
    setDraft(null);
  };
  const sliderEvents = {
    onPointerUp: () => commit(),
    onKeyUp: () => commit(),
    onBlur: () => draft && commit(),
  };

  if (!hasAudio) {
    return (
      <p className="mt-2 text-sm text-neutral-500" data-testid="clip-audio-panel">
        This clip has no audio.
      </p>
    );
  }

  return (
    <fieldset
      className="mt-2 grid gap-x-4 gap-y-1 rounded-lg bg-neutral-900 p-3 sm:grid-cols-[auto_1fr_1fr_1fr]"
      data-testid="clip-audio-panel"
    >
      <legend className="sr-only">Clip audio</legend>
      <button
        type="button"
        className={`flex min-h-11 items-center justify-center gap-1 self-end rounded-lg px-3 text-sm font-medium ${
          current.muted ? 'bg-red-900 text-red-100' : 'bg-neutral-800 active:bg-neutral-700'
        }`}
        aria-pressed={current.muted}
        onClick={() => commit({ muted: !current.muted })}
      >
        {current.muted ? '🔇 Muted' : '🔊 Mute'}
      </button>
      <Slider
        label="Volume"
        value={current.volume}
        min={0}
        max={MAX_VOLUME}
        step={0.05}
        display={`${Math.round(current.volume * 100)}%`}
        disabled={current.muted}
        onChange={(volume) => change({ volume })}
        {...sliderEvents}
      />
      <Slider
        label="Fade in"
        value={Math.min(current.fadeInSec, maxFade)}
        min={0}
        max={maxFade}
        step={0.1}
        display={`${current.fadeInSec.toFixed(1)} s`}
        disabled={current.muted}
        onChange={(fadeInSec) => change({ fadeInSec })}
        {...sliderEvents}
      />
      <Slider
        label="Fade out"
        value={Math.min(current.fadeOutSec, maxFade)}
        min={0}
        max={maxFade}
        step={0.1}
        display={`${current.fadeOutSec.toFixed(1)} s`}
        disabled={current.muted}
        onChange={(fadeOutSec) => change({ fadeOutSec })}
        {...sliderEvents}
      />
    </fieldset>
  );
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: ReactNode;
  disabled: boolean;
  onChange: (v: number) => void;
  onPointerUp: () => void;
  onKeyUp: () => void;
  onBlur: () => void;
}) {
  return (
    <label className="flex flex-col text-sm">
      <span className="flex justify-between text-neutral-400">
        {props.label}
        <output className="font-mono text-neutral-200">{props.display}</output>
      </span>
      {/* h-11: a 44 px touch target around the thin track. */}
      <input
        type="range"
        className="h-11 w-full accent-yellow-400"
        aria-label={props.label}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onPointerUp={props.onPointerUp}
        onKeyUp={props.onKeyUp}
        onBlur={props.onBlur}
      />
    </label>
  );
}
