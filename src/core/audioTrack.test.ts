import { describe, expect, it } from 'vitest';
import {
  addAudioItem,
  duckAt,
  DUCK_LEVEL,
  itemEnd,
  itemGainAt,
  itemPasses,
  moveAudioItem,
  removeAudioItem,
  setAudioItemAudio,
  setAudioItemLength,
  setDuck,
  sourceAt,
} from './audioTrack';
import { addClip, EMPTY_PROJECT, removeMedia, type AudioItem, type Project } from './project';

const ids = (...list: string[]) => {
  let i = 0;
  return () => list[i++] ?? `x${i}`;
};
// 20 s of video.
const video = addClip(
  EMPTY_PROJECT,
  { id: 'v', durationSec: 20, frameRate: 30 },
  { id: () => 'c' },
);
const song = { id: 'song', durationSec: 8, frameRate: null };
const talk = { id: 'talk', durationSec: 3, frameRate: null };
const item = (p: Project, id: string): AudioItem => {
  const a = p.audioItems?.find((x) => x.id === id);
  if (!a) throw new Error(id);
  return a;
};

describe('audio items', () => {
  const p = addAudioItem(
    addAudioItem(video, song, 'music', 0, ids('m')),
    talk,
    'voice',
    5,
    ids('v1'),
  );
  const m = item(p, 'm');
  const v = item(p, 'v1');

  it('places music looping to the end of the video and a voice-over once', () => {
    expect(m).toMatchObject({ startSec: 0, durationSec: null, loop: true, outSec: 8 });
    expect(itemEnd(m, 20)).toBe(20);
    expect(v).toMatchObject({ startSec: 5, durationSec: 3, loop: false });
    expect(itemEnd(v, 20)).toBe(8);
    expect(p.media['song']).toBeDefined();
  });

  it('maps timeline time to source time, looping music', () => {
    expect(sourceAt(m, 3, 20)).toBe(3);
    expect(sourceAt(m, 11, 20)).toBe(3); // second pass
    expect(sourceAt(m, 20, 20)).toBeNull(); // cut at the video's end
    expect(sourceAt(v, 4.9, 20)).toBeNull();
    expect(sourceAt(v, 6, 20)).toBe(1);
    expect(itemPasses(m, 6, 18, 20)).toEqual([
      { timelineStart: 6, sourceFrom: 6, sourceTo: 8 },
      { timelineStart: 8, sourceFrom: 0, sourceTo: 8 },
      { timelineStart: 16, sourceFrom: 0, sourceTo: 2 },
    ]);
  });

  it('ducks music around voice-overs with ramps, unless turned off', () => {
    expect(duckAt(p, 1, 20)).toBe(1);
    expect(duckAt(p, 6, 20)).toBeCloseTo(DUCK_LEVEL);
    expect(duckAt(p, 4.85, 20)).toBeCloseTo(1 - (1 - DUCK_LEVEL) * 0.5); // half-way down
    expect(itemGainAt(p, m, 6, 20)).toBeCloseTo(DUCK_LEVEL);
    expect(itemGainAt(p, v, 6, 20)).toBe(1); // voices are not ducked
    expect(duckAt(setDuck(p, false), 6, 20)).toBe(1);
    expect(setDuck(p, true)).toBe(p);
  });

  it('applies volume and fades over the item length', () => {
    const q = setAudioItemAudio(p, 'm', { volume: 0.5, fadeOutSec: 4 });
    expect(itemGainAt(q, item(q, 'm'), 2, 20)).toBeCloseTo(0.5);
    expect(itemGainAt(q, item(q, 'm'), 18, 20)).toBeCloseTo(0.25); // half-way through the fade
    expect(
      setAudioItemAudio(q, 'm', { volume: 1, fadeOutSec: 0 }).audioItems?.[0],
    ).not.toHaveProperty('audio');
  });

  it('moves, resizes and removes items', () => {
    expect(item(moveAudioItem(p, 'v1', 30), 'v1').startSec).toBeCloseTo(19.9);
    expect(item(moveAudioItem(p, 'v1', -2), 'v1').startSec).toBe(0);
    const q = setAudioItemLength(p, 'm', { durationSec: 10, loop: false });
    expect(itemEnd(item(q, 'm'), 20)).toBe(8); // one pass only
    expect(itemEnd(item(setAudioItemLength(q, 'm', { loop: true }), 'm'), 20)).toBe(10);
    expect(removeAudioItem(p, 'm').audioItems).toHaveLength(1);
    expect(removeAudioItem(p, 'nope')).toBe(p);
    expect(removeMedia(p, 'talk').audioItems?.map((a) => a.id)).toEqual(['m']);
  });
});
