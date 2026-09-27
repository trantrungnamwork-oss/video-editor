/**
 * Segmented export: the timeline is encoded as independent video segments so an interrupted
 * export (tab backgrounded, codec reclaimed, tab killed) resumes from the last finished one.
 * Pure helpers; the I/O lives in exportPipeline.ts.
 */
import type { FileIdentity } from '../fileIdentity';
import type { ScheduledClip } from '../preview/sequence';

export { identityOf, sameFile, type FileIdentity } from '../fileIdentity';

/** Work lost on an interruption is at most one segment. */
export const SEGMENT_SEC = 10;

export interface Segment {
  index: number;
  startSec: number;
  endSec: number;
}

/**
 * A remainder shorter than this joins the previous segment. Container durations often run a few
 * ms past the last video frame (AAC priming/padding), and such a sliver would hold no frame.
 */
export const MIN_TAIL_SEC = 1;

export function planSegments(totalSec: number, segmentSec = SEGMENT_SEC): Segment[] {
  const segments: Segment[] = [];
  for (let i = 0, t = 0; t < totalSec - 1e-6; i++, t += segmentSec) {
    const endSec = totalSec - (t + segmentSec) < MIN_TAIL_SEC ? totalSec : t + segmentSec;
    segments.push({ index: i, startSec: t, endSec });
    if (endSec === totalSec) break;
  }
  return segments;
}

export interface ClipSlice {
  clip: ScheduledClip;
  /** Source range to decode for this segment. */
  sourceFrom: number;
  sourceTo: number;
}

/** Parts of clips that fall inside timeline range [a, b). */
export function slicesInRange(seq: readonly ScheduledClip[], a: number, b: number): ClipSlice[] {
  const out: ClipSlice[] = [];
  for (const clip of seq) {
    const from = Math.max(a, clip.startSec);
    const to = Math.min(b, clip.endSec);
    if (to - from <= 1e-9) continue;
    out.push({
      clip,
      sourceFrom: clip.inSec + (from - clip.startSec),
      sourceTo: clip.inSec + (to - clip.startSec),
    });
  }
  return out;
}

/** Share of the total work per phase, for one progress bar. */
const WEIGHTS = { audio: 0.05, video: 0.9, mux: 0.05 } as const;
export type Phase = keyof typeof WEIGHTS;

export function overallFraction(p: { audio: number; video: number; mux: number }): number {
  return WEIGHTS.audio * p.audio + WEIGHTS.video * p.video + WEIGHTS.mux * p.mux;
}

/**
 * Everything that determines the encoded output. A checkpoint is only reused when the key of the
 * job being resumed is identical.
 */
export function jobKey(job: {
  clips: readonly { file: FileIdentity; inSec: number; outSec: number; hasAudio: boolean }[];
  width: number;
  height: number;
  format: { container: string; video: string; audio: string };
  videoBitrate: number;
}): string {
  return JSON.stringify({
    v: 1,
    segmentSec: SEGMENT_SEC,
    clips: job.clips.map((c) => [
      c.file.name,
      c.file.size,
      c.file.lastModified,
      c.inSec,
      c.outSec,
      c.hasAudio,
    ]),
    size: [job.width, job.height],
    format: [job.format.container, job.format.video, job.format.audio],
    bitrate: job.videoBitrate,
  });
}
