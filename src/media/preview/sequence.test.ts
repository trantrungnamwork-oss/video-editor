import { describe, expect, it } from 'vitest';
import {
  audioWindow,
  indexAt,
  schedule,
  sequenceDuration,
  sourceTime,
  timelineTime,
  type SequenceClip,
} from './sequence';

const clip = (id: string, inSec: number, outSec: number): SequenceClip => ({
  id,
  mediaId: id,
  file: new File([], `${id}.mp4`),
  inSec,
  outSec,
  frameRate: 30,
  hasAudio: true,
});

describe('sequence mapping', () => {
  const s = schedule([clip('a', 2, 5), clip('b', 0, 4)]);
  const [a, b] = s;
  if (!a || !b) throw new Error('schedule lost clips');

  it('lays clips out back to back', () => {
    expect(s.map((c) => [c.startSec, c.endSec])).toEqual([
      [0, 3],
      [3, 7],
    ]);
    expect(sequenceDuration(s)).toBe(7);
    expect(sequenceDuration([])).toBe(0);
  });

  it('finds the clip at a timeline time', () => {
    expect(indexAt(s, 0)).toBe(0);
    expect(indexAt(s, 2.999)).toBe(0);
    expect(indexAt(s, 3)).toBe(1);
    expect(indexAt(s, 100)).toBe(1);
    expect(indexAt([], 0)).toBe(-1);
  });

  it('maps between timeline and source time', () => {
    expect(sourceTime(a, 1)).toBe(3);
    expect(sourceTime(b, 4)).toBe(1);
    expect(sourceTime(a, 10)).toBe(5);
    expect(timelineTime(b, 1)).toBe(4);
    // A frame decoded from before the in point (GOP pre-roll) pins to the clip start.
    expect(timelineTime(a, 1.9)).toBe(0);
  });

  it('cuts audio buffers to the clip window', () => {
    // 0.1 s buffer at 48 kHz starting at 1.95 s, clip window [2, 5)
    expect(audioWindow(1.95, 4800, 48_000, 2, 5)).toEqual({ offset: 2400, count: 2400 });
    // buffer straddling the out point
    expect(audioWindow(4.95, 4800, 48_000, 2, 5)).toEqual({ offset: 0, count: 2400 });
    expect(audioWindow(5.2, 4800, 48_000, 2, 5)).toBeNull();
  });
});
