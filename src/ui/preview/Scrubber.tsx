import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerSnapshot, PreviewPlayer } from '../../media/preview/previewPlayer';
import { requestThumbnails } from '../../media/thumbnailClient';
import { usePlayhead } from './usePlayhead';

const THUMB_COUNT = 12;
const TRACK_HEIGHT_PX = 56;

/**
 * Touch-first scrubber over a thumbnail strip. Dragging shows keyframes (cheap); releasing lands
 * on the exact frame. No hover dependence; the whole 56 px track is the touch target.
 */
export function Scrubber({
  player,
  snapshot,
  file,
}: {
  player: PreviewPlayer;
  snapshot: PlayerSnapshot;
  file: File;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ resume: boolean } | null>(null);
  const thumbs = useThumbnailUrls(file);
  const duration = snapshot.durationSec;

  usePlayhead(
    player,
    useCallback(
      (t: number) => {
        const head = headRef.current;
        const track = trackRef.current;
        if (!head || !track || duration <= 0) return;
        head.style.transform = `translateX(${(t / duration) * track.clientWidth}px)`;
        track.setAttribute('aria-valuenow', t.toFixed(2));
      },
      [duration],
    ),
  );

  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration;
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={duration}
      data-testid="scrubber"
      className="relative w-full touch-none select-none overflow-hidden rounded-md bg-neutral-800"
      style={{ height: TRACK_HEIGHT_PX }}
      onPointerDown={(e) => {
        if (!snapshot.ready) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { resume: player.state.playing };
        if (player.state.playing) player.pause();
        player.seek(timeAt(e.clientX), false);
      }}
      onPointerMove={(e) => {
        if (drag.current) player.seek(timeAt(e.clientX), false);
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        const { resume } = drag.current;
        drag.current = null;
        player.seek(timeAt(e.clientX), true);
        if (resume) player.play();
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <div className="pointer-events-none flex h-full w-full" data-testid="thumbnail-strip">
        {thumbs.map((url, i) => (
          <img
            key={i}
            src={url}
            alt=""
            draggable={false}
            className="h-full min-w-0 flex-1 object-cover"
          />
        ))}
      </div>
      <div
        ref={headRef}
        className="pointer-events-none absolute top-0 left-0 h-full w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
      />
    </div>
  );
}

function useThumbnailUrls(file: File): string[] {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    let created: string[] = [];
    const height = Math.round(TRACK_HEIGHT_PX * Math.min(window.devicePixelRatio || 1, 2));
    requestThumbnails(file, { count: THUMB_COUNT, height }).then(
      (thumbs) => {
        if (cancelled) return;
        const byBlob = new Map<Blob, string>();
        created = thumbs.map((t) => {
          const existing = byBlob.get(t.blob);
          if (existing) return existing;
          const url = URL.createObjectURL(t.blob);
          byBlob.set(t.blob, url);
          return url;
        });
        setUrls(created);
      },
      (err: unknown) => console.warn('[thumbnails]', err),
    );
    return () => {
      cancelled = true;
      for (const u of new Set(created)) URL.revokeObjectURL(u);
      setUrls([]);
    };
  }, [file]);
  return urls;
}
