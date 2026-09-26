import { describe, expect, it } from 'vitest';
import { dropIndex, fitPps, MAX_PPS, MIN_PPS, zoomAround } from './timelineMath';

describe('timeline math', () => {
  it('fits a duration into a width within limits', () => {
    expect(fitPps(10, 400)).toBe(40);
    expect(fitPps(10_000, 400)).toBe(MIN_PPS);
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
});
