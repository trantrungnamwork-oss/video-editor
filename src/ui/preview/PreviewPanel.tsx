import { useEffect, useRef, useState } from 'react';
import { PreviewPlayer, type PlayerSnapshot } from '../../media/preview/previewPlayer';
import type { SequenceClip } from '../../media/preview/sequence';
import { PlayerControls } from './PlayerControls';
import { StatsPanel } from './StatsPanel';

interface Props {
  clips: SequenceClip[];
  /** Output frame size (first clip's display size); clips of other shapes are letterboxed. */
  width: number;
  height: number;
  onPlayer: (player: PreviewPlayer | null) => void;
}

export function PreviewPanel({ clips, width, height, onPlayer }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [player, setPlayer] = useState<PreviewPlayer | null>(null);
  const [snapshot, setSnapshot] = useState<PlayerSnapshot | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Created here rather than in JSX: transferControlToOffscreen() works once per element, and
    // StrictMode runs effects twice.
    const canvas = document.createElement('canvas');
    canvas.className = 'block h-full w-full';
    canvas.dataset['testid'] = 'preview-canvas';
    container.appendChild(canvas);

    const p = new PreviewPlayer(canvas);
    const unsubscribe = p.subscribe(setSnapshot);
    setPlayer(p);
    onPlayer(p);

    return () => {
      unsubscribe();
      setPlayer(null);
      setSnapshot(null);
      onPlayer(null);
      void p.dispose().then((final) => {
        const open = final?.openFrames ?? 'unknown (worker did not answer)';
        if (open !== 0) console.error(`[preview] frame leak: openFrames=${open}`);
        else console.info(`[preview] disposed openFrames=0 decoded=${final?.decodedFrames}`);
      });
      canvas.remove();
    };
  }, [onPlayer]);

  useEffect(() => {
    player?.setSequence(clips);
  }, [player, clips]);

  useEffect(() => {
    const container = containerRef.current;
    if (!player || !container) return;
    const resize = () =>
      player.resize(
        container.clientWidth || 1,
        container.clientHeight || 1,
        window.devicePixelRatio || 1,
        width,
        height,
      );
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();
    return () => ro.disconnect();
  }, [player, width, height]);

  return (
    <section className="flex flex-col gap-2" data-testid="preview">
      <div
        ref={containerRef}
        className="w-full overflow-hidden rounded-lg bg-black"
        style={{ aspectRatio: `${width} / ${height}`, maxHeight: '45dvh' }}
      />
      {snapshot?.error && (
        <p className="rounded bg-red-950 p-2 text-sm text-red-300" role="alert">
          Preview failed: {snapshot.error}
        </p>
      )}
      {player && snapshot && <PlayerControls player={player} snapshot={snapshot} />}
      {player && <StatsPanel player={player} />}
    </section>
  );
}
