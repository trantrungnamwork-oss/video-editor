/**
 * Timeline ↔ source mapping for sequence playback. Pure; shared by the worker session and tests.
 */

export interface SequenceClip {
  id: string;
  mediaId: string;
  file: File;
  /** Source range [inSec, outSec). */
  inSec: number;
  outSec: number;
  frameRate: number | null;
  /** Whether the clip's audio track exists and is decodable on this device. */
  hasAudio: boolean;
}

export interface ScheduledClip extends SequenceClip {
  startSec: number;
  endSec: number;
}

export function schedule(clips: readonly SequenceClip[]): ScheduledClip[] {
  let t = 0;
  return clips.map((c) => {
    const startSec = t;
    t += c.outSec - c.inSec;
    return { ...c, startSec, endSec: t };
  });
}

export const sequenceDuration = (s: readonly ScheduledClip[]) => s[s.length - 1]?.endSec ?? 0;

/** Index of the clip covering timeline time t ([start, end); the end maps to the last clip). */
export function indexAt(s: readonly ScheduledClip[], t: number): number {
  if (s.length === 0) return -1;
  const i = s.findIndex((c) => t < c.endSec);
  return i < 0 ? s.length - 1 : i;
}

/** Source time inside clip `c` for timeline time t, clamped to the clip's range. */
export function sourceTime(c: ScheduledClip, t: number): number {
  return Math.min(c.outSec, Math.max(c.inSec, c.inSec + (t - c.startSec)));
}

/** Timeline time of a source timestamp; frames decoded from before the in point pin to the start. */
export function timelineTime(c: ScheduledClip, sourceTs: number): number {
  return c.startSec + Math.max(0, sourceTs - c.inSec);
}

/**
 * Portion of an audio buffer [ts, ts + frames/sampleRate) that falls inside [fromSec, outSec),
 * in frames. Null when nothing is inside.
 */
export function audioWindow(
  ts: number,
  frames: number,
  sampleRate: number,
  fromSec: number,
  outSec: number,
): { offset: number; count: number } | null {
  const offset = Math.max(0, Math.round((fromSec - ts) * sampleRate));
  const end = Math.min(frames, Math.round((outSec - ts) * sampleRate));
  return end > offset ? { offset, count: end - offset } : null;
}
