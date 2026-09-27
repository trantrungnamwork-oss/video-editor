import { describe, expect, it } from 'vitest';
import {
  addClip,
  clipStarts,
  EMPTY_PROJECT,
  locate,
  moveClip,
  projectDuration,
  removeClip,
  removeMedia,
  splitAt,
  trimIn,
  trimOut,
  type MediaSource,
  type Project,
} from './project';

const ids = () => {
  let n = 0;
  return () => `c${++n}`;
};

const A: MediaSource = { id: 'a', durationSec: 10, frameRate: 30 };
const B: MediaSource = { id: 'b', durationSec: 4, frameRate: 25 };

function twoClips(): Project {
  const id = ids();
  return addClip(addClip(EMPTY_PROJECT, A, { id }), B, { id });
}

describe('project model', () => {
  it('adds clips back to back and computes layout', () => {
    const p = twoClips();
    expect(p.clips.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(projectDuration(p)).toBe(14);
    expect(clipStarts(p)).toEqual([0, 10]);
  });

  it('inserts at an index and ignores zero-length media', () => {
    const p = addClip(
      twoClips(),
      { id: 'z', durationSec: 2, frameRate: 30 },
      { index: 1, id: () => 'mid' },
    );
    expect(p.clips.map((c) => c.id)).toEqual(['c1', 'mid', 'c2']);
    const q = addClip(p, { id: 'empty', durationSec: 0, frameRate: 30 });
    expect(q).toBe(p);
  });

  it('locates timeline time to clip and source time', () => {
    const p = twoClips();
    expect(locate(p, 0)).toMatchObject({ index: 0, sourceSec: 0 });
    expect(locate(p, 10)).toMatchObject({ index: 1, startSec: 10, sourceSec: 0 });
    expect(locate(p, 12.5)).toMatchObject({ index: 1, sourceSec: 2.5 });
    expect(locate(p, 99)).toMatchObject({ index: 1, sourceSec: 4 }); // clamped to the end
    expect(locate(EMPTY_PROJECT, 0)).toBeNull();
  });

  it('trims in and out with frame snapping and a minimum length', () => {
    let p = twoClips();
    p = trimIn(p, 'c1', 1.01); // snaps to 30 fps grid
    expect(p.clips[0]?.inSec).toBeCloseTo(1, 6);
    p = trimOut(p, 'c1', 3.333);
    expect(p.clips[0]?.outSec).toBeCloseTo(3.3333, 3);
    expect(projectDuration(p)).toBeCloseTo(2.3333 + 4, 3);

    const [tooFar] = trimIn(p, 'c1', 50).clips;
    expect((tooFar?.outSec ?? 0) - (tooFar?.inSec ?? 0)).toBeCloseTo(0.1, 6);
    expect(trimOut(p, 'c2', 99).clips[1]?.outSec).toBe(4); // capped at media length
    expect(trimIn(p, 'c2', -5).clips[1]?.inSec).toBe(0);
  });

  it('returns the same instance for no-op edits', () => {
    const p = twoClips();
    expect(trimIn(p, 'c1', 0)).toBe(p);
    expect(trimIn(p, 'missing', 1)).toBe(p);
    expect(removeClip(p, 'missing')).toBe(p);
    expect(moveClip(p, 'c1', 0)).toBe(p);
  });

  it('splits at the playhead on a frame boundary', () => {
    const p = splitAt(twoClips(), 12.51, () => 'new'); // 2.51 s into clip b at 25 fps
    expect(p.clips.map((c) => [c.id, c.inSec, c.outSec])).toEqual([
      ['c1', 0, 10],
      ['c2', 0, 2.52],
      ['new', 2.52, 4],
    ]);
    expect(projectDuration(p)).toBe(14);
  });

  it('refuses splits that would create a sliver', () => {
    const p = twoClips();
    expect(splitAt(p, 0.02)).toBe(p);
    expect(splitAt(p, 9.97)).toBe(p);
    expect(splitAt(p, 14)).toBe(p);
  });

  it('removes and reorders clips', () => {
    const p = twoClips();
    expect(removeClip(p, 'c1').clips.map((c) => c.id)).toEqual(['c2']);
    expect(moveClip(p, 'c1', 5).clips.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(moveClip(p, 'c2', -3).clips.map((c) => c.id)).toEqual(['c2', 'c1']);
  });

  it('removing a media source removes its clips', () => {
    const p = splitAt(twoClips(), 3, () => 'split');
    const q = removeMedia(p, 'a');
    expect(q.clips.map((c) => c.id)).toEqual(['c2']);
    expect(Object.keys(q.media)).toEqual(['b']);
    expect(removeMedia(q, 'a')).toBe(q);
  });
});
