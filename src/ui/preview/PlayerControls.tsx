import { useCallback, useRef } from 'react';
import type { PlayerSnapshot, PreviewPlayer } from '../../media/preview/previewPlayer';
import { formatDuration } from '../format';
import { usePlayhead } from './usePlayhead';

const BTN =
  'flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-neutral-800 px-3 font-medium active:bg-neutral-700 disabled:opacity-40';

export function PlayerControls({
  player,
  snapshot,
}: {
  player: PreviewPlayer;
  snapshot: PlayerSnapshot;
}) {
  const timeRef = useRef<HTMLSpanElement>(null);
  usePlayhead(
    player,
    useCallback((t: number) => {
      if (timeRef.current) timeRef.current.textContent = formatDuration(t);
    }, []),
  );

  const disabled = !snapshot.ready;
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className={BTN}
        disabled={disabled}
        onClick={() => player.stepFrame(-1)}
        aria-label="Previous frame"
      >
        ‹
      </button>
      <button
        type="button"
        className={`${BTN} min-w-20 bg-green-600 text-white active:bg-green-700`}
        disabled={disabled}
        onClick={() => (snapshot.playing ? player.pause() : player.play())}
        data-testid="play-toggle"
      >
        {snapshot.playing ? 'Pause' : 'Play'}
      </button>
      <button
        type="button"
        className={BTN}
        disabled={disabled}
        onClick={() => player.stepFrame(1)}
        aria-label="Next frame"
      >
        ›
      </button>
      <span className="ml-auto font-mono text-sm tabular-nums text-neutral-300">
        <span ref={timeRef} data-testid="current-time">
          0:00.0
        </span>{' '}
        / {formatDuration(snapshot.durationSec)}
      </span>
    </div>
  );
}
