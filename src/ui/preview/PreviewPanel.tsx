import { useEffect, useRef, useState } from 'react';
import type { MediaInfo } from '../../media/probe';
import { PreviewPlayer, type PlayerSnapshot } from '../../media/preview/previewPlayer';
import { PlayerControls } from './PlayerControls';
import { Scrubber } from './Scrubber';
import { StatsPanel } from './StatsPanel';

interface Props {
  file: File;
  info: MediaInfo;
}

export function PreviewPanel({ file, info }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [player, setPlayer] = useState<PreviewPlayer | null>(null);
  const [snapshot, setSnapshot] = useState<PlayerSnapshot | null>(null);
  const { displayWidth, displayHeight } = info.video;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // The canvas is created here rather than in JSX: transferControlToOffscreen() works once per
    // element, and StrictMode runs effects twice.
    const canvas = document.createElement('canvas');
    canvas.className = 'block h-full w-full';
    canvas.dataset['testid'] = 'preview-canvas';
    container.appendChild(canvas);

    const p = new PreviewPlayer(canvas, file);
    const unsubscribe = p.subscribe(setSnapshot);
    setPlayer(p);

    const resize = () =>
      p.resize(
        container.clientWidth || 1,
        container.clientHeight || 1,
        window.devicePixelRatio || 1,
        displayWidth,
        displayHeight,
      );
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    return () => {
      ro.disconnect();
      unsubscribe();
      setPlayer(null);
      setSnapshot(null);
      void p.dispose().then((final) => {
        const open = final?.openFrames ?? 'unknown (worker did not answer)';
        if (open !== 0) console.error(`[preview] frame leak: openFrames=${open}`);
        else console.info(`[preview] disposed openFrames=0 decoded=${final?.decodedFrames}`);
      });
      canvas.remove();
    };
  }, [file, displayWidth, displayHeight]);

  useEffect(() => {
    if (!player) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (player.state.playing) player.pause();
        else player.play();
      } else if (e.key === 'ArrowRight') player.stepFrame(1);
      else if (e.key === 'ArrowLeft') player.stepFrame(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player]);

  return (
    <section className="flex flex-col gap-2" data-testid="preview">
      <div
        ref={containerRef}
        className="w-full overflow-hidden rounded-lg bg-black"
        style={{ aspectRatio: `${displayWidth} / ${displayHeight}`, maxHeight: '50dvh' }}
      />
      {snapshot?.error && (
        <p className="rounded bg-red-950 p-2 text-sm text-red-300" role="alert">
          Preview failed: {snapshot.error}
        </p>
      )}
      {player && snapshot && (
        <>
          <PlayerControls player={player} snapshot={snapshot} />
          <Scrubber player={player} snapshot={snapshot} file={file} />
          <StatsPanel player={player} />
        </>
      )}
    </section>
  );
}
