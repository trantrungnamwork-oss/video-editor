import { describe, expect, it } from 'vitest';
import { schedule } from '../preview/sequence';
import { jobKey, overallFraction, planSegments, slicesInRange } from './segments';

const file = (name: string) => new File([], name, { lastModified: 1 });

describe('planSegments', () => {
  it('covers the timeline with fixed-length segments', () => {
    expect(planSegments(25, 10)).toEqual([
      { index: 0, startSec: 0, endSec: 10 },
      { index: 1, startSec: 10, endSec: 20 },
      { index: 2, startSec: 20, endSec: 25 },
    ]);
    expect(planSegments(10, 10)).toHaveLength(1);
    expect(planSegments(0, 10)).toEqual([]);
  });

  it('folds a short remainder into the last segment', () => {
    // 60 s of video whose AAC track runs a few ms longer: no empty sliver segment.
    expect(planSegments(60.0107, 10)).toHaveLength(6);
    expect(planSegments(60.0107, 10).at(-1)).toEqual({ index: 5, startSec: 50, endSec: 60.0107 });
    expect(planSegments(20.5, 10).map((s) => s.endSec)).toEqual([10, 20.5]);
    expect(planSegments(21, 10).map((s) => s.endSec)).toEqual([10, 20, 21]);
    expect(planSegments(0.5, 10)).toEqual([{ index: 0, startSec: 0, endSec: 0.5 }]);
  });
});

describe('slicesInRange', () => {
  const seq = schedule([
    { id: 'a', mediaId: 'a', file: file('a'), inSec: 5, outSec: 12, frameRate: 30, hasAudio: true },
    { id: 'b', mediaId: 'b', file: file('b'), inSec: 0, outSec: 8, frameRate: 30, hasAudio: false },
  ]); // a: timeline [0, 7), b: [7, 15)

  it('maps a timeline range to source ranges of the clips it touches', () => {
    expect(slicesInRange(seq, 0, 10).map((s) => [s.clip.id, s.sourceFrom, s.sourceTo])).toEqual([
      ['a', 5, 12],
      ['b', 0, 3],
    ]);
    expect(slicesInRange(seq, 10, 20).map((s) => [s.clip.id, s.sourceFrom, s.sourceTo])).toEqual([
      ['b', 3, 8],
    ]);
  });
});

describe('progress and job identity', () => {
  it('weights phases into one fraction', () => {
    expect(overallFraction({ audio: 1, video: 0.5, mux: 0 })).toBeCloseTo(0.5);
    expect(overallFraction({ audio: 1, video: 1, mux: 1 })).toBeCloseTo(1);
  });

  it('changes the job key when anything affecting the output changes', () => {
    const job = {
      clips: [
        { file: { name: 'a', size: 1, lastModified: 1 }, inSec: 0, outSec: 5, hasAudio: true },
      ],
      width: 1280,
      height: 720,
      format: { container: 'mp4', video: 'avc', audio: 'aac' },
      videoBitrate: 5e6,
    };
    const k = jobKey(job);
    expect(jobKey({ ...job })).toBe(k);
    expect(jobKey({ ...job, width: 1920 })).not.toBe(k);
    const [clip] = job.clips;
    if (!clip) throw new Error('fixture');
    expect(jobKey({ ...job, clips: [{ ...clip, outSec: 4 }] })).not.toBe(k);
  });
});
