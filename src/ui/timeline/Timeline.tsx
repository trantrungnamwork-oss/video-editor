import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  clipDuration,
  clipStarts,
  MIN_CLIP_SEC,
  type Clip,
  type Project,
} from '../../core/project';
import { clampPps, dropIndex, fitPps, zoomAround } from '../../core/timelineMath';
import type { PreviewPlayer } from '../../media/preview/previewPlayer';
import { useProjectStore } from '../../state/projectStore';
import { usePlayhead } from '../preview/usePlayhead';
import { TimelineToolbar } from './TimelineToolbar';
import { THUMB_COUNT, useThumbnails } from '../useThumbnails';

const TRACK_HEIGHT = 64;
/** Thumbnail tile width: 16:9 at track height. */
const TILE_WIDTH = Math.round((TRACK_HEIGHT * 16) / 9);
const RULER_HEIGHT = 20;
/** Touch target of trim handles (≥ 44 px, CLAUDE.md §7); the visible bar is narrower. */
const HANDLE_HIT = 44;
const HANDLE_BAR = 14;
/** How long after the last user scroll event we consider scrolling finished. */
const SCROLL_SETTLE_MS = 120;

type Pending =
  | { kind: 'trim'; clipId: string; edge: 'in' | 'out'; sourceSec: number }
  | { kind: 'move'; clipId: string; dx: number };

interface Props {
  player: PreviewPlayer | null;
  project: Project;
  files: ReadonlyMap<string, File>;
}

/**
 * Touch-first timeline. The playhead is fixed at the centre of the viewport and the track scrolls
 * underneath it with native (momentum) scrolling, so scrubbing is just scrolling. Two-finger pinch
 * or ctrl+wheel zooms around the gesture point.
 */
export function Timeline({ player, project, files }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [pps, setPps] = useState<number | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const select = useProjectStore((s) => s.select);

  const starts = useMemo(() => clipStarts(project), [project]);
  const duration = useMemo(() => project.clips.reduce((d, c) => d + clipDuration(c), 0), [project]);
  const pad = viewportWidth / 2;
  const zoom = pps ?? fitPps(duration, Math.max(1, viewportWidth - 32));

  // --- viewport size ---
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth));
    ro.observe(el);
    setViewportWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // --- scroll <-> playhead sync ---
  const expectedScroll = useRef(0);
  const interacting = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const scrollToTime = useCallback(
    (t: number) => {
      const el = viewportRef.current;
      if (!el) return;
      const target = Math.round(t * zoom);
      if (Math.abs(el.scrollLeft - target) <= 1) return;
      expectedScroll.current = target;
      el.scrollLeft = target;
    },
    [zoom],
  );

  usePlayhead(
    player,
    useCallback(
      (t: number) => {
        if (!interacting.current) scrollToTime(t);
      },
      [scrollToTime],
    ),
  );

  // Keep the playhead time fixed when the zoom or layout changes.
  useLayoutEffect(() => {
    if (player) scrollToTime(player.currentTime);
  }, [zoom, viewportWidth, player, scrollToTime]);

  const onScroll = () => {
    const el = viewportRef.current;
    if (!el || !player) return;
    if (Math.abs(el.scrollLeft - expectedScroll.current) <= 1) return; // our own scroll
    expectedScroll.current = el.scrollLeft;
    interacting.current = true;
    if (player.state.playing) player.pause();
    const t = el.scrollLeft / zoom;
    player.seek(t, false);
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      interacting.current = false;
      player.seek(el.scrollLeft / zoom, true);
    }, SCROLL_SETTLE_MS);
  };

  // --- pinch / ctrl+wheel zoom ---
  const zoomRef = useRef(zoom);
  useLayoutEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !player) return;
    let pinch: { dist: number; pps: number; t: number; anchor: number } | null = null;
    const centreOffset = (clientX: number) => {
      const r = el.getBoundingClientRect();
      return clientX - (r.left + r.width / 2);
    };
    const applyZoom = (base: number, scale: number, t: number, anchor: number) => {
      const z = zoomAround(base, scale, t, anchor);
      interacting.current = true;
      setPps(z.pps);
      player.seek(z.playheadSec, false);
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        interacting.current = false;
        player.seek(player.currentTime, true);
      }, SCROLL_SETTLE_MS);
    };
    const onTouchStart = (e: TouchEvent) => {
      const [a, b] = [e.touches[0], e.touches[1]];
      if (e.touches.length !== 2 || !a || !b) return;
      pinch = {
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        pps: zoomRef.current,
        t: player.currentTime,
        anchor: centreOffset((a.clientX + b.clientX) / 2),
      };
    };
    const onTouchMove = (e: TouchEvent) => {
      const [a, b] = [e.touches[0], e.touches[1]];
      if (!pinch || e.touches.length !== 2 || !a || !b) return;
      e.preventDefault();
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      applyZoom(pinch.pps, dist / pinch.dist, pinch.t, pinch.anchor);
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel/trackpad scroll stays native
      e.preventDefault();
      applyZoom(
        zoomRef.current,
        Math.exp(-e.deltaY / 200),
        player.currentTime,
        centreOffset(e.clientX),
      );
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('wheel', onWheel);
    };
  }, [player]);

  // --- trim & move gestures (pointer events on handles with touch-action: none) ---
  const gesture = useRef<{ x: number; base: number } | null>(null);

  const startTrim = (e: ReactPointerEvent, clip: Clip, edge: 'in' | 'out') => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (player?.state.playing) player.pause();
    gesture.current = { x: e.clientX, base: edge === 'in' ? clip.inSec : clip.outSec };
    setPending({ kind: 'trim', clipId: clip.id, edge, sourceSec: gesture.current.base });
  };

  const moveTrim = (e: ReactPointerEvent, clip: Clip, index: number, edge: 'in' | 'out') => {
    const g = gesture.current;
    if (!g || pending?.kind !== 'trim') return;
    const mediaEnd = project.media[clip.mediaId]?.durationSec ?? clip.outSec;
    const raw = g.base + (e.clientX - g.x) / zoom;
    const sourceSec =
      edge === 'in'
        ? Math.min(Math.max(0, raw), clip.outSec - MIN_CLIP_SEC)
        : Math.max(Math.min(mediaEnd, raw), clip.inSec + MIN_CLIP_SEC);
    setPending({ kind: 'trim', clipId: clip.id, edge, sourceSec });
    // Show the frame at the new edge (old layout: clip still starts at starts[index]).
    const start = starts[index] ?? 0;
    const edgeT = start + (sourceSec - clip.inSec) - (edge === 'out' ? 1e-3 : 0);
    player?.seek(Math.max(0, edgeT), false);
  };

  const endTrim = (clip: Clip, index: number) => {
    const p = pending;
    gesture.current = null;
    setPending(null);
    if (p?.kind !== 'trim') return;
    const s = useProjectStore.getState();
    if (p.edge === 'in') s.trimIn(clip.id, p.sourceSec);
    else s.trimOut(clip.id, p.sourceSec);
    // Land on the edited edge in the new layout.
    const start = starts[index] ?? 0;
    const updated = useProjectStore.getState().history.present.clips.find((c) => c.id === clip.id);
    if (updated && player) {
      const t = p.edge === 'in' ? start : start + clipDuration(updated) - 1e-3;
      player.seek(Math.max(0, t), true);
    }
  };

  const startMove = (e: ReactPointerEvent, clip: Clip) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { x: e.clientX, base: 0 };
    setPending({ kind: 'move', clipId: clip.id, dx: 0 });
  };

  const moveTargetIndex = (clipId: string, dx: number): number => {
    const idx = project.clips.findIndex((c) => c.id === clipId);
    const clip = project.clips[idx];
    if (!clip) return idx;
    const centre = (starts[idx] ?? 0) + clipDuration(clip) / 2 + dx / zoom;
    const others: { start: number; end: number }[] = [];
    let t = 0;
    for (const c of project.clips) {
      if (c.id === clipId) continue;
      others.push({ start: t, end: t + clipDuration(c) });
      t += clipDuration(c);
    }
    return dropIndex(centre, others);
  };

  const endMove = () => {
    const p = pending;
    gesture.current = null;
    setPending(null);
    if (p?.kind !== 'move') return;
    useProjectStore.getState().moveClip(p.clipId, moveTargetIndex(p.clipId, p.dx));
  };

  // --- render ---
  const contentWidth = duration * zoom + viewportWidth;
  const dropMarker =
    pending?.kind === 'move'
      ? markerTime(project, moveTargetIndex(pending.clipId, pending.dx), pending.clipId)
      : null;

  return (
    <div className="select-none" data-testid="timeline" data-pps={zoom.toFixed(3)}>
      <div className="relative">
        <div
          ref={viewportRef}
          onScroll={onScroll}
          onClick={(e) => {
            if (e.target === e.currentTarget || (e.target as HTMLElement).dataset['track'])
              select(null);
          }}
          className="overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-lg bg-neutral-900 [scrollbar-width:none]"
          style={{ touchAction: 'pan-x' }}
          data-testid="timeline-viewport"
        >
          <div
            className="relative"
            style={{ width: contentWidth, height: RULER_HEIGHT + TRACK_HEIGHT + 16 }}
            data-track="1"
          >
            <Ruler duration={duration} pps={zoom} pad={pad} />
            {project.clips.map((clip, i) => (
              <ClipBlock
                key={clip.id}
                clip={clip}
                file={files.get(clip.mediaId)}
                mediaDurationSec={project.media[clip.mediaId]?.durationSec ?? clip.outSec}
                left={pad + (starts[i] ?? 0) * zoom}
                pps={zoom}
                selected={clip.id === selectedClipId}
                pending={pending && pending.clipId === clip.id ? pending : null}
                onSelect={() => select(clip.id)}
                onTrimStart={(e, edge) => startTrim(e, clip, edge)}
                onTrimMove={(e, edge) => moveTrim(e, clip, i, edge)}
                onTrimEnd={() => endTrim(clip, i)}
                onMoveStart={(e) => startMove(e, clip)}
                onMoveMove={(e) => {
                  const g = gesture.current;
                  if (g && pending?.kind === 'move')
                    setPending({ ...pending, dx: e.clientX - g.x });
                }}
                onMoveEnd={endMove}
              />
            ))}
            {dropMarker !== null && (
              <div
                className="pointer-events-none absolute w-1 rounded bg-green-400"
                style={{
                  left: pad + dropMarker * zoom - 2,
                  top: RULER_HEIGHT,
                  height: TRACK_HEIGHT + 8,
                }}
                data-testid="drop-marker"
              />
            )}
          </div>
        </div>
        {/* Fixed playhead at the viewport centre. */}
        <div
          className="pointer-events-none absolute top-0 bottom-0 left-1/2 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
          data-testid="timeline-playhead"
        />
      </div>
      <div className="mt-2">
        <TimelineToolbar
          player={player}
          extra={
            <ZoomButtons
              onZoom={(scale) => {
                const t = player?.currentTime ?? 0;
                setPps(clampPps(zoom * scale));
                player?.seek(t, true);
              }}
            />
          }
        />
      </div>
    </div>
  );
}

/** Timeline time at which the dragged clip would be inserted (layout without that clip). */
function markerTime(project: Project, toIndex: number, clipId: string): number {
  return project.clips
    .filter((c) => c.id !== clipId)
    .slice(0, toIndex)
    .reduce((t, c) => t + clipDuration(c), 0);
}

function ZoomButtons({ onZoom }: { onZoom: (scale: number) => void }) {
  const cls =
    'flex size-11 items-center justify-center rounded-lg bg-neutral-800 text-lg active:bg-neutral-700';
  return (
    <div className="ml-auto flex gap-2">
      <button type="button" className={cls} aria-label="Zoom out" onClick={() => onZoom(1 / 1.5)}>
        −
      </button>
      <button type="button" className={cls} aria-label="Zoom in" onClick={() => onZoom(1.5)}>
        +
      </button>
    </div>
  );
}

function Ruler({ duration, pps, pad }: { duration: number; pps: number; pad: number }) {
  const step =
    [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pps >= 60) ?? 600;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 1e-9; t += step) ticks.push(t);
  return (
    <div
      className="pointer-events-none absolute top-0 left-0 w-full"
      style={{ height: RULER_HEIGHT }}
    >
      {ticks.map((t) => (
        <div
          key={t}
          className="absolute top-0 h-full border-l border-neutral-600 pl-1 text-[10px] leading-5 text-neutral-400"
          style={{ left: pad + t * pps }}
        >
          {formatTick(t, step)}
        </div>
      ))}
    </div>
  );
}

function formatTick(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const sec = step < 1 ? s.toFixed(step < 0.5 ? 2 : 1) : String(Math.round(s));
  return m > 0 ? `${m}:${sec.padStart(2, '0')}` : `${sec}s`;
}

interface ClipBlockProps {
  clip: Clip;
  file: File | undefined;
  mediaDurationSec: number;
  left: number;
  pps: number;
  selected: boolean;
  pending: Pending | null;
  onSelect: () => void;
  onTrimStart: (e: ReactPointerEvent, edge: 'in' | 'out') => void;
  onTrimMove: (e: ReactPointerEvent, edge: 'in' | 'out') => void;
  onTrimEnd: () => void;
  onMoveStart: (e: ReactPointerEvent) => void;
  onMoveMove: (e: ReactPointerEvent) => void;
  onMoveEnd: () => void;
}

function ClipBlock(props: ClipBlockProps) {
  const { clip, file, pps, selected, pending } = props;
  const thumbs = useThumbnails(file);

  // Visual source range while a trim is in progress; the layout of other clips stays put until
  // release, then the edit ripples.
  let inSec = clip.inSec;
  let outSec = clip.outSec;
  if (pending?.kind === 'trim') {
    if (pending.edge === 'in') inSec = pending.sourceSec;
    else outSec = pending.sourceSec;
  }
  const left = props.left + (inSec - clip.inSec) * pps;
  const width = Math.max(2, (outSec - inSec) * pps);
  const dx = pending?.kind === 'move' ? pending.dx : 0;
  // Fixed-size tiles, each showing the thumbnail nearest to the source time at its centre.
  const tileCount = thumbs.length ? Math.ceil(width / TILE_WIDTH) : 0;
  const tiles = Array.from({ length: tileCount }, (_, i) => {
    const src = inSec + ((i + 0.5) * TILE_WIDTH) / pps;
    const slot = Math.floor((src / props.mediaDurationSec) * THUMB_COUNT);
    return thumbs[Math.min(thumbs.length - 1, Math.max(0, slot))];
  });

  return (
    <div
      className={`absolute rounded-md ${selected ? 'z-10 ring-2 ring-yellow-400' : ''} ${
        dx ? 'z-20 opacity-80 shadow-lg shadow-black' : ''
      }`}
      style={{
        left,
        width,
        top: RULER_HEIGHT + 4,
        height: TRACK_HEIGHT,
        transform: dx ? `translateX(${dx}px) translateY(-6px)` : undefined,
      }}
      onClick={(e) => {
        e.stopPropagation();
        props.onSelect();
      }}
      data-testid="timeline-clip"
      data-clip-id={clip.id}
      data-selected={selected}
    >
      <div className="absolute inset-0 overflow-hidden rounded-md bg-neutral-700">
        <div className="pointer-events-none absolute top-0 left-0 flex h-full">
          {tiles.map((url, i) => (
            <img
              key={i}
              src={url}
              alt=""
              draggable={false}
              className="h-full object-cover"
              style={{ width: TILE_WIDTH, minWidth: TILE_WIDTH }}
            />
          ))}
        </div>
        <span
          className="absolute bottom-0.5 left-1 rounded bg-black/60 px-1 font-mono text-[10px] text-white"
          data-testid="clip-duration"
        >
          {(outSec - inSec).toFixed(1)}s
        </span>
      </div>

      {selected && (
        <>
          <TrimHandle
            edge="in"
            onDown={(e) => props.onTrimStart(e, 'in')}
            onMove={(e) => props.onTrimMove(e, 'in')}
            onUp={props.onTrimEnd}
          />
          <TrimHandle
            edge="out"
            onDown={(e) => props.onTrimStart(e, 'out')}
            onMove={(e) => props.onTrimMove(e, 'out')}
            onUp={props.onTrimEnd}
          />
          {width >= 72 && (
            <div
              role="button"
              aria-label="Drag to reorder"
              data-testid="clip-grip"
              className="absolute top-1/2 left-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full bg-black/60 text-lg text-white"
              style={{ touchAction: 'none' }}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={props.onMoveStart}
              onPointerMove={props.onMoveMove}
              onPointerUp={props.onMoveEnd}
              onPointerCancel={props.onMoveEnd}
            >
              ⠿
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TrimHandle({
  edge,
  onDown,
  onMove,
  onUp,
}: {
  edge: 'in' | 'out';
  onDown: (e: ReactPointerEvent) => void;
  onMove: (e: ReactPointerEvent) => void;
  onUp: () => void;
}) {
  return (
    <div
      role="slider"
      aria-label={edge === 'in' ? 'Trim start' : 'Trim end'}
      aria-valuenow={0}
      data-testid={`trim-${edge}`}
      className="absolute top-0 z-10 flex h-full cursor-ew-resize items-center justify-center"
      style={{
        width: HANDLE_HIT,
        [edge === 'in' ? 'left' : 'right']: -HANDLE_HIT / 2,
        touchAction: 'none',
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <div
        className="flex h-full items-center justify-center rounded-sm bg-yellow-400 text-[10px] font-bold text-black"
        style={{ width: HANDLE_BAR }}
      >
        {edge === 'in' ? '⟨' : '⟩'}
      </div>
    </div>
  );
}
