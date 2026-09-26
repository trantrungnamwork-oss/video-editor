import { useEffect, useState } from 'react';
import type { PlayerStats, PreviewPlayer } from '../../media/preview/previewPlayer';

/** Live pipeline counters, for real-device testing (frame leaks, drops, audio underruns). */
export function StatsPanel({ player }: { player: PreviewPlayer }) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<PlayerStats | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const poll = () => void player.getStats().then((s) => alive && setStats(s));
    poll();
    const id = setInterval(poll, 500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [open, player]);

  return (
    <details
      className="text-sm text-neutral-400"
      onToggle={(e) => setOpen(e.currentTarget.open)}
      data-testid="stats"
    >
      <summary className="flex min-h-11 cursor-pointer items-center">Playback stats</summary>
      {stats && (
        <dl className="grid grid-cols-2 gap-x-4 font-mono text-xs sm:grid-cols-3">
          <Stat label="open frames" value={stats.openFrames} testId="stat-open-frames" />
          <Stat label="peak open" value={stats.peakOpenFrames} testId="stat-peak-open" />
          <Stat label="decoded" value={stats.decodedFrames} testId="stat-decoded" />
          <Stat label="dropped" value={stats.droppedFrames} testId="stat-dropped" />
          <Stat label="audio chunks" value={stats.audioScheduledChunks} testId="stat-audio" />
          <Stat label="audio late" value={stats.audioLateChunks} testId="stat-audio-late" />
          <Stat
            label="canvas"
            value={`${stats.canvasWidth}×${stats.canvasHeight}`}
            testId="stat-canvas"
          />
          <Stat
            label="shown ts"
            value={stats.shownTimestamp?.toFixed(3) ?? '–'}
            testId="stat-shown"
          />
        </dl>
      )}
    </details>
  );
}

function Stat({ label, value, testId }: { label: string; value: number | string; testId: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="text-neutral-200" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
