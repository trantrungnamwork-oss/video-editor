/** Pixel/time math for the timeline view (zoom is expressed as pixels per second). */

export const MIN_PPS = 8;
export const MAX_PPS = 600;

export const clampPps = (pps: number) => Math.min(MAX_PPS, Math.max(MIN_PPS, pps));

/** Zoom level that fits `durationSec` into `widthPx`. */
export function fitPps(durationSec: number, widthPx: number): number {
  if (!(durationSec > 0) || !(widthPx > 0)) return 100;
  return clampPps(widthPx / durationSec);
}

/**
 * New zoom after a pinch by `scale`, keeping the time under `anchorOffsetPx` (distance from the
 * viewport's playhead line) fixed. Returns the new pps and the new playhead time.
 */
export function zoomAround(
  pps: number,
  scale: number,
  playheadSec: number,
  anchorOffsetPx: number,
): { pps: number; playheadSec: number } {
  const next = clampPps(pps * scale);
  const anchorSec = playheadSec + anchorOffsetPx / pps;
  return { pps: next, playheadSec: Math.max(0, anchorSec - anchorOffsetPx / next) };
}

/**
 * Index a dragged clip should move to, given the dragged clip's centre on the timeline and the
 * other clips' [start, end) ranges (the dragged clip excluded, in order).
 */
export function dropIndex(centreSec: number, others: readonly { start: number; end: number }[]) {
  let i = 0;
  for (const o of others) {
    if (centreSec > (o.start + o.end) / 2) i++;
  }
  return i;
}
