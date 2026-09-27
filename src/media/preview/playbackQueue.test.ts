import { describe, expect, it } from 'vitest';
import { FrameTracker } from './frameTracker';
import { PlaybackQueue, type TimedFrame } from './playbackQueue';

const flush = () => new Promise((r) => setTimeout(r, 0));

function frames(tracker: FrameTracker, count: number, fps = 10) {
  let produced = 0;
  async function* gen(): AsyncGenerator<TimedFrame> {
    for (let i = 0; i < count; i++) {
      produced++;
      yield tracker.track({ timestamp: i / fps, close: () => undefined });
    }
  }
  return { gen: gen(), produced: () => produced };
}

describe('FrameTracker', () => {
  it('counts open frames and tolerates double close', () => {
    const t = new FrameTracker();
    const a = t.track({ close: () => undefined });
    t.track({ close: () => undefined });
    expect(t.open).toBe(2);
    a.close();
    a.close();
    expect(t.open).toBe(1);
    expect(t.peak).toBe(2);
    expect(t.total).toBe(2);
  });
});

describe('PlaybackQueue', () => {
  it('reads ahead no further than its capacity', async () => {
    const tracker = new FrameTracker();
    const src = frames(tracker, 100);
    const q = new PlaybackQueue(src.gen, 4);
    await flush();
    expect(q.size).toBe(4);
    expect(tracker.open).toBe(4);
    await q.dispose();
  });

  it('hands out the newest due frame and drops late ones', async () => {
    const tracker = new FrameTracker();
    const q = new PlaybackQueue(frames(tracker, 100).gen, 6);
    await flush();
    expect(q.take(-1)).toBeNull();

    const f0 = q.take(0);
    expect(f0?.timestamp).toBe(0);
    f0?.close();

    // Clock jumped 3 frames ahead: frames 0.1 and 0.2 are late.
    const f3 = q.take(0.3);
    expect(f3?.timestamp).toBeCloseTo(0.3);
    expect(q.dropped).toBe(2);
    f3?.close();
    await q.dispose();
    expect(tracker.open).toBe(0);
  });

  it('reports ended after the source is drained', async () => {
    const tracker = new FrameTracker();
    const q = new PlaybackQueue(frames(tracker, 3).gen, 6);
    await flush();
    q.take(10)?.close();
    await flush();
    expect(q.ended).toBe(true);
    expect(tracker.open).toBe(0);
  });

  it('closes queued and in-flight frames on dispose', async () => {
    const tracker = new FrameTracker();
    let release: () => void = () => undefined;
    async function* slow(): AsyncGenerator<TimedFrame> {
      yield tracker.track({ timestamp: 0, close: () => undefined });
      await new Promise<void>((r) => (release = r));
      yield tracker.track({ timestamp: 0.1, close: () => undefined });
    }
    const q = new PlaybackQueue(slow(), 6);
    await flush();
    const disposed = q.dispose();
    release();
    await disposed;
    await flush();
    expect(tracker.open).toBe(0);
  });

  it('forwards source errors', async () => {
    const errors: unknown[] = [];
    // eslint-disable-next-line require-yield
    async function* broken(): AsyncGenerator<TimedFrame> {
      throw new Error('decoder died');
    }
    const q = new PlaybackQueue(broken(), 6, (e) => errors.push(e));
    await flush();
    expect(errors).toHaveLength(1);
    expect(q.ended).toBe(true);
  });
});
