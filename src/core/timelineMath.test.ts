import { describe, expect, it } from 'vitest';
import { clampPps, dropIndex, fitPps, MAX_PPS, MIN_PPS, minPps, zoomAround } from './timelineMath';

describe('timeline math', () => {
  it('fits a duration into a width within limits', () => {
    expect(fitPps(10, 400)).toBe(40);
    // Long projects fit too: the zoom-out limit scales with the project length.
    expect(fitPps(180, 360)).toBe(2);
    expect(fitPps(10_000, 400)).toBeCloseTo(0.04);
    expect(fitPps(0.01, 400)).toBe(MAX_PPS);
    expect(fitPps(0, 400)).toBe(100);
  });

  it('keeps the pinch anchor fixed while zooming', () => {
    // Anchor 100 px right of the playhead at 50 px/s = 2 s after the playhead (t = 7 s).
    const z = zoomAround(50, 2, 5, 100);
    expect(z.pps).toBe(100);
    expect(z.playheadSec + 100 / z.pps).toBeCloseTo(7);
  });

  it('never moves the playhead before zero', () => {
    // Zooming out around a point right of the playhead would move the playhead to -2 s.
    expect(zoomAround(50, 0.5, 0, 100).playheadSec).toBe(0);
  });

  it('computes the drop index from clip midpoints', () => {
    const others = [
      { start: 0, end: 4 },
      { start: 4, end: 6 },
    ];
    expect(dropIndex(1, others)).toBe(0);
    expect(dropIndex(2.5, others)).toBe(1);
    expect(dropIndex(5.5, others)).toBe(2);
  });

  it('lets long projects zoom out to a quarter of the viewport', () => {
    // 3-minute clip on a 360 px phone timeline: fit = 2 px/s, limit = 0.5 px/s.
    expect(minPps(180, 360)).toBe(0.5);
    expect(clampPps(1, minPps(180, 360))).toBe(1);
    expect(zoomAround(2, 0.1, 0, 0, minPps(180, 360)).pps).toBe(0.5);
    // Short projects keep the fixed limit.
    expect(minPps(5, 360)).toBe(MIN_PPS);
  });
});
