import { DEFAULT_LAYOUT, type AspectRatio, type ClipLayout } from './frame';

/**
 * Project model: a single video track of clips played back to back.
 *
 * Pure and immutable. Every operation returns a new Project (or the same instance when the edit is
 * a no-op, so callers can skip history entries). No React, no DOM: reusable from a desktop build.
 */

export interface MediaSource {
  id: string;
  durationSec: number;
  /** Used to snap edit points to frame boundaries; null falls back to DEFAULT_FPS. */
  frameRate: number | null;
}

/** Per-clip audio settings. Absent means DEFAULT_CLIP_AUDIO. */
export interface ClipAudio {
  /** Linear gain, 0..MAX_VOLUME (1 = unchanged). */
  volume: number;
  muted: boolean;
  /** Linear fade from silence at the clip start / to silence at the clip end, in seconds. */
  fadeInSec: number;
  fadeOutSec: number;
}

export const DEFAULT_CLIP_AUDIO: ClipAudio = {
  volume: 1,
  muted: false,
  fadeInSec: 0,
  fadeOutSec: 0,
};
export const MAX_VOLUME = 2;

export interface Clip {
  id: string;
  mediaId: string;
  /** Source range [inSec, outSec) in the media's own timeline. */
  inSec: number;
  outSec: number;
  audio?: ClipAudio;
  /** Placement in the output frame; absent means DEFAULT_LAYOUT (whole picture, centred). */
  layout?: ClipLayout;
}

export interface Project {
  readonly clips: readonly Clip[];
  readonly media: Readonly<Record<string, MediaSource>>;
  /** Output frame shape; absent means 'source' (the first clip's shape). */
  readonly aspect?: AspectRatio;
}

export const EMPTY_PROJECT: Project = { clips: [], media: {} };

/** Shortest clip an edit may produce. */
export const MIN_CLIP_SEC = 0.1;
const DEFAULT_FPS = 30;

export type IdFactory = () => string;
const defaultId: IdFactory = () => crypto.randomUUID();

export const clipDuration = (c: Clip) => c.outSec - c.inSec;

export function projectDuration(p: Project): number {
  return p.clips.reduce((sum, c) => sum + clipDuration(c), 0);
}

/** Timeline start time of every clip. */
export function clipStarts(p: Project): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const c of p.clips) {
    starts.push(t);
    t += clipDuration(c);
  }
  return starts;
}

export interface Located {
  index: number;
  clip: Clip;
  /** Timeline time at which the clip starts. */
  startSec: number;
  /** Source time inside the clip's media. */
  sourceSec: number;
}

/**
 * Finds the clip playing at timeline time t. Clips cover [start, end); t at or past the very end
 * maps to the last frame region of the last clip.
 */
export function locate(p: Project, t: number): Located | null {
  let start = 0;
  for (const [index, clip] of p.clips.entries()) {
    const end = start + clipDuration(clip);
    const isLast = index === p.clips.length - 1;
    if (t < end || isLast) {
      const offset = Math.min(Math.max(0, t - start), clipDuration(clip));
      return { index, clip, startSec: start, sourceSec: clip.inSec + offset };
    }
    start = end;
  }
  return null;
}

export function frameRateOf(p: Project, mediaId: string): number {
  return p.media[mediaId]?.frameRate ?? DEFAULT_FPS;
}

/** Rounds to the nearest frame boundary of a given frame rate. */
export function snapToFrame(sec: number, fps: number): number {
  return Math.round(sec * fps) / fps;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function addClip(
  p: Project,
  media: MediaSource,
  opts: { index?: number; id?: IdFactory } = {},
): Project {
  if (!(media.durationSec > 0)) return p;
  const clip: Clip = {
    id: (opts.id ?? defaultId)(),
    mediaId: media.id,
    inSec: 0,
    outSec: media.durationSec,
  };
  const clips = [...p.clips];
  clips.splice(clamp(opts.index ?? clips.length, 0, clips.length), 0, clip);
  return { ...p, clips, media: { ...p.media, [media.id]: media } };
}

function replaceClip(p: Project, clipId: string, update: (c: Clip) => Clip): Project {
  let changed = false;
  const clips = p.clips.map((c) => {
    if (c.id !== clipId) return c;
    const next = update(c);
    if (
      next.inSec !== c.inSec ||
      next.outSec !== c.outSec ||
      !sameAudio(next.audio, c.audio) ||
      !sameLayout(next.layout, c.layout)
    ) {
      changed = true;
    }
    return next;
  });
  return changed ? { ...p, clips } : p;
}

/** Moves a clip's in point (source time), snapped to a frame, keeping at least MIN_CLIP_SEC. */
export function trimIn(p: Project, clipId: string, inSec: number): Project {
  return replaceClip(p, clipId, (c) => {
    const fps = frameRateOf(p, c.mediaId);
    const next = clamp(snapToFrame(inSec, fps), 0, c.outSec - MIN_CLIP_SEC);
    return { ...c, inSec: Math.max(0, next) };
  });
}

/** Moves a clip's out point (source time), snapped to a frame, keeping at least MIN_CLIP_SEC. */
export function trimOut(p: Project, clipId: string, outSec: number): Project {
  return replaceClip(p, clipId, (c) => {
    const fps = frameRateOf(p, c.mediaId);
    const mediaEnd = p.media[c.mediaId]?.durationSec ?? c.outSec;
    const next = clamp(snapToFrame(outSec, fps), c.inSec + MIN_CLIP_SEC, mediaEnd);
    return { ...c, outSec: Math.min(mediaEnd, next) };
  });
}

/**
 * Splits the clip under timeline time t into two at the nearest frame boundary. No-op when the
 * cut would leave a piece shorter than MIN_CLIP_SEC.
 */
export function splitAt(p: Project, t: number, id: IdFactory = defaultId): Project {
  const hit = locate(p, t);
  if (!hit) return p;
  const { clip, index } = hit;
  const cut = snapToFrame(hit.sourceSec, frameRateOf(p, clip.mediaId));
  if (cut - clip.inSec < MIN_CLIP_SEC - 1e-9 || clip.outSec - cut < MIN_CLIP_SEC - 1e-9) return p;
  // The fade-in stays at the start of the left piece, the fade-out at the end of the right one.
  const left: Clip = { ...clip, outSec: cut };
  const right: Clip = { ...clip, id: id(), inSec: cut };
  if (clip.audio) {
    left.audio = { ...clip.audio, fadeOutSec: 0 };
    right.audio = { ...clip.audio, fadeInSec: 0 };
  }
  const clips = [...p.clips];
  clips.splice(index, 1, left, right);
  return { ...p, clips };
}

export function removeClip(p: Project, clipId: string): Project {
  const clips = p.clips.filter((c) => c.id !== clipId);
  return clips.length === p.clips.length ? p : { ...p, clips };
}

export function moveClip(p: Project, clipId: string, toIndex: number): Project {
  const from = p.clips.findIndex((c) => c.id === clipId);
  if (from < 0) return p;
  const to = clamp(toIndex, 0, p.clips.length - 1);
  if (from === to) return p;
  const clips = [...p.clips];
  const [clip] = clips.splice(from, 1);
  if (!clip) return p;
  clips.splice(to, 0, clip);
  return { ...p, clips };
}

export const audioOf = (c: Clip): ClipAudio => c.audio ?? DEFAULT_CLIP_AUDIO;

function sameAudio(a: ClipAudio | undefined, b: ClipAudio | undefined): boolean {
  const x = a ?? DEFAULT_CLIP_AUDIO;
  const y = b ?? DEFAULT_CLIP_AUDIO;
  return (
    x.volume === y.volume &&
    x.muted === y.muted &&
    x.fadeInSec === y.fadeInSec &&
    x.fadeOutSec === y.fadeOutSec
  );
}

/**
 * Updates a clip's audio settings. Volume is clamped to [0, MAX_VOLUME]; fades to the clip
 * length. Fades are stored as asked (a later trim may shorten the clip) and clamped when applied.
 */
export function setClipAudio(p: Project, clipId: string, patch: Partial<ClipAudio>): Project {
  return replaceClip(p, clipId, (c) => {
    const merged = { ...audioOf(c), ...patch };
    const dur = clipDuration(c);
    const audio: ClipAudio = {
      volume: clamp(round3(merged.volume), 0, MAX_VOLUME),
      muted: merged.muted,
      fadeInSec: clamp(round3(merged.fadeInSec), 0, dur),
      fadeOutSec: clamp(round3(merged.fadeOutSec), 0, dur),
    };
    if (sameAudio(audio, DEFAULT_CLIP_AUDIO)) {
      const rest = { ...c };
      delete rest.audio;
      return rest;
    }
    return { ...c, audio };
  });
}

const round3 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0);

/** Drops a media source and every clip that uses it. */
export function removeMedia(p: Project, mediaId: string): Project {
  if (!(mediaId in p.media)) return p;
  const media = Object.fromEntries(Object.entries(p.media).filter(([id]) => id !== mediaId));
  return { ...p, clips: p.clips.filter((c) => c.mediaId !== mediaId), media };
}

export const aspectOf = (p: Project): AspectRatio => p.aspect ?? 'source';

export function setAspect(p: Project, aspect: AspectRatio): Project {
  if (aspectOf(p) === aspect) return p;
  if (aspect === 'source') {
    const rest = { ...p };
    delete rest.aspect;
    return rest;
  }
  return { ...p, aspect };
}

export const layoutOf = (c: Clip): ClipLayout => c.layout ?? DEFAULT_LAYOUT;

function sameLayout(a: ClipLayout | undefined, b: ClipLayout | undefined): boolean {
  const x = a ?? DEFAULT_LAYOUT;
  const y = b ?? DEFAULT_LAYOUT;
  return x.fit === y.fit && x.panX === y.panX && x.panY === y.panY;
}

/** Updates how a clip sits in the frame; pan is clamped to [-1, 1]. */
export function setClipLayout(p: Project, clipId: string, patch: Partial<ClipLayout>): Project {
  return replaceClip(p, clipId, (c) => {
    const merged = { ...layoutOf(c), ...patch };
    const layout: ClipLayout = {
      fit: merged.fit,
      panX: clamp(round3(merged.panX), -1, 1),
      panY: clamp(round3(merged.panY), -1, 1),
    };
    if (sameLayout(layout, DEFAULT_LAYOUT)) {
      const rest = { ...c };
      delete rest.layout;
      return rest;
    }
    return { ...c, layout };
  });
}
