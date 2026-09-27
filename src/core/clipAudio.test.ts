import { describe, expect, it } from 'vitest';
import { applyGain, gainAt, isSilent } from './audioGain';
import {
  addClip,
  EMPTY_PROJECT,
  setClipAudio,
  splitAt,
  DEFAULT_CLIP_AUDIO,
  type ClipAudio,
  type MediaSource,
} from './project';

const A: MediaSource = { id: 'a', durationSec: 10, frameRate: 30 };
const one = () => addClip(EMPTY_PROJECT, A, { id: () => 'c1' });
const audio = (patch: Partial<ClipAudio>): ClipAudio => ({ ...DEFAULT_CLIP_AUDIO, ...patch });

describe('setClipAudio', () => {
  it('stores clamped settings and is a no-op when nothing changes', () => {
    const p = setClipAudio(one(), 'c1', { volume: 5, fadeInSec: 20, fadeOutSec: -1 });
    expect(p.clips[0]?.audio).toEqual({ volume: 2, muted: false, fadeInSec: 10, fadeOutSec: 0 });
    expect(setClipAudio(p, 'c1', { volume: 2 })).toBe(p);
    expect(setClipAudio(p, 'nope', { muted: true })).toBe(p);
  });

  it('drops the field when back to defaults (old projects stay identical)', () => {
    const p = setClipAudio(one(), 'c1', { muted: true });
    const back = setClipAudio(p, 'c1', { muted: false });
    expect(back.clips[0]).not.toHaveProperty('audio');
    expect(setClipAudio(one(), 'c1', { volume: 1 })).toEqual(one());
  });

  it('keeps the fade-in on the left piece and the fade-out on the right one when splitting', () => {
    const p = setClipAudio(one(), 'c1', { volume: 0.5, fadeInSec: 1, fadeOutSec: 2 });
    const [left, right] = splitAt(p, 5, () => 'c2').clips;
    expect(left?.audio).toEqual(audio({ volume: 0.5, fadeInSec: 1 }));
    expect(right?.audio).toEqual(audio({ volume: 0.5, fadeOutSec: 2 }));
  });
});

describe('gain envelope', () => {
  it('applies volume, mute and linear fades', () => {
    expect(gainAt(undefined, 3, 10)).toBe(1);
    expect(gainAt(audio({ volume: 0.5 }), 3, 10)).toBe(0.5);
    expect(gainAt(audio({ muted: true }), 3, 10)).toBe(0);
    const f = audio({ fadeInSec: 2, fadeOutSec: 4 });
    expect(gainAt(f, 0, 10)).toBe(0);
    expect(gainAt(f, 1, 10)).toBeCloseTo(0.5);
    expect(gainAt(f, 5, 10)).toBe(1);
    expect(gainAt(f, 8, 10)).toBeCloseTo(0.5);
    expect(gainAt(f, 10, 10)).toBe(0);
  });

  it('limits overlapping fades to half the clip each', () => {
    const f = audio({ fadeInSec: 3, fadeOutSec: 3 }); // clip trimmed to 2 s
    expect(gainAt(f, 1, 2)).toBeCloseTo(1);
    expect(gainAt(f, 0.5, 2)).toBeCloseTo(0.5);
    expect(gainAt(f, 1.5, 2)).toBeCloseTo(0.5);
  });

  it('scales samples in place and hard-clips boosts', () => {
    const planes = [new Float32Array([0.2, 0.8, -0.8]), new Float32Array([0.1, 0.1, 0.1])];
    applyGain(planes, 48_000, 0, 10, audio({ volume: 2 }));
    expect(Array.from(planes[0] ?? [])).toEqual([expect.closeTo(0.4), 1, -1]);
    expect(Array.from(planes[1] ?? [])).toEqual([0.2, 0.2, 0.2].map((v) => expect.closeTo(v)));

    const ramp = [new Float32Array(4).fill(1)];
    applyGain(ramp, 4, 0, 10, audio({ fadeInSec: 1 })); // 4 Hz: frames at 0, .25, .5, .75 s
    expect(Array.from(ramp[0] ?? [])).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('marks muted or zero-volume clips as silent', () => {
    expect(isSilent(undefined)).toBe(false);
    expect(isSilent(audio({ volume: 0 }))).toBe(true);
    expect(isSilent(audio({ muted: true }))).toBe(true);
    expect(isSilent(audio({ volume: 0.1 }))).toBe(false);
  });
});
