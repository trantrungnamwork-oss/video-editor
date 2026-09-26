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

export interface Clip {
  id: string;
  mediaId: string;
  /** Source range [inSec, outSec) in the media's own timeline. */
  inSec: number;
  outSec: number;
}

export interface Project {
  readonly clips: readonly Clip[];
  readonly media: Readonly<Record<string, MediaSource>>;
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
  return { clips, media: { ...p.media, [media.id]: media } };
}

function replaceClip(p: Project, clipId: string, update: (c: Clip) => Clip): Project {
  let changed = false;
  const clips = p.clips.map((c) => {
    if (c.id !== clipId) return c;
    const next = update(c);
    if (next.inSec !== c.inSec || next.outSec !== c.outSec) changed = true;
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
  const left: Clip = { ...clip, outSec: cut };
  const right: Clip = { ...clip, id: id(), inSec: cut };
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

/** Drops a media source and every clip that uses it. */
export function removeMedia(p: Project, mediaId: string): Project {
  if (!(mediaId in p.media)) return p;
  const media = Object.fromEntries(Object.entries(p.media).filter(([id]) => id !== mediaId));
  return { clips: p.clips.filter((c) => c.mediaId !== mediaId), media };
}
