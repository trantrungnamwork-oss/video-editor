import { describe, expect, it } from 'vitest';
import { concatPlanes, Resampler } from './resample';

const ramp = (n: number, start = 0) => Float32Array.from({ length: n }, (_, i) => start + i);

describe('Resampler', () => {
  it('passes matching rates through and maps mono to stereo', () => {
    const r = new Resampler(48_000, 48_000, 2);
    const [l, rr] = r.process([ramp(4)]);
    expect(Array.from(l ?? [])).toEqual([0, 1, 2, 3]);
    expect(Array.from(rr ?? [])).toEqual([0, 1, 2, 3]);
  });

  it('upsamples with the right length over many chunks', () => {
    const r = new Resampler(22_050, 48_000, 2);
    let total = 0;
    for (let i = 0; i < 100; i++) total += r.process([ramp(1024), ramp(1024)])[0]?.length ?? 0;
    // 102 400 input samples at 22.05 kHz ≈ 222 912 output samples at 48 kHz.
    expect(Math.abs(total - (102_400 * 48_000) / 22_050)).toBeLessThan(2);
  });

  it('interpolates continuously across chunk boundaries', () => {
    const r = new Resampler(1, 2, 1); // doubling: every other output is a midpoint
    const a = r.process([ramp(3, 0)])[0] ?? new Float32Array(0);
    const b = r.process([ramp(3, 3)])[0] ?? new Float32Array(0);
    const joined = [...a, ...b];
    expect(joined).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
  });

  it('drops extra channels and concatenates planes', () => {
    const r = new Resampler(48_000, 48_000, 2);
    const out = r.process([ramp(2, 0), ramp(2, 10), ramp(2, 20)]);
    expect(Array.from(concatPlanes(out))).toEqual([0, 1, 10, 11]);
  });
});
