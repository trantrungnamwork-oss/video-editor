import { describe, expect, it } from 'vitest';
import { AudioScheduler, type AudioContextLike } from './audioScheduler';

class FakeNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started: { when: number; offset: number } | null = null;
  stopped = false;
  connect() {}
  disconnect() {}
  start(when: number, offset: number) {
    this.started = { when, offset };
  }
  stop() {
    this.stopped = true;
  }
}

function fakeCtx(now = 10, audible?: number) {
  const nodes: FakeNode[] = [];
  const ctx = {
    currentTime: now,
    outputLatency: 0.05,
    destination: {} as AudioNode,
    getOutputTimestamp: () => ({ contextTime: audible ?? 0, performanceTime: 0 }),
    createBuffer: (_c: number, len: number) => ({ copyToChannel() {}, length: len }),
    createBufferSource: () => {
      const n = new FakeNode();
      nodes.push(n);
      return n;
    },
  };
  return { ctx: ctx as unknown as AudioContextLike & { currentTime: number }, nodes };
}

const chunk = (timestamp: number, frames = 4800, sampleRate = 48_000) => ({
  timestamp,
  sampleRate,
  channels: [new Float32Array(frames), new Float32Array(frames)],
});

describe('AudioScheduler', () => {
  it('schedules chunks relative to the anchor', () => {
    const { ctx, nodes } = fakeCtx(10);
    const s = new AudioScheduler(ctx);
    s.start(5, 10.2);
    s.schedule(chunk(5.1));
    expect(nodes[0]?.started?.when).toBeCloseTo(10.3);
    expect(nodes[0]?.started?.offset).toBe(0);
    expect(s.scheduledUntil).toBeCloseTo(5.2);
  });

  it('trims a chunk that straddles the start point', () => {
    const { ctx, nodes } = fakeCtx(10);
    const s = new AudioScheduler(ctx);
    s.start(5, 10);
    s.schedule(chunk(4.95)); // 0.1 s chunk, first 0.05 s is before the anchor
    expect(nodes[0]?.started).toEqual({ when: 10, offset: expect.closeTo(0.05) as number });
    expect(s.lateChunks).toBe(0);
  });

  it('drops chunks that are entirely in the past', () => {
    const { ctx, nodes } = fakeCtx(12);
    const s = new AudioScheduler(ctx);
    s.start(5, 10);
    s.schedule(chunk(5.5));
    expect(nodes).toHaveLength(0);
    expect(s.lateChunks).toBe(1);
  });

  it('derives media time from the audible output timestamp', () => {
    const { ctx } = fakeCtx(11, 10.95);
    const s = new AudioScheduler(ctx);
    s.start(5, 10.2);
    expect(s.mediaTime()).toBeCloseTo(5.75);
  });

  it('falls back to currentTime minus output latency and never runs before the anchor', () => {
    const { ctx } = fakeCtx(10.1);
    const s = new AudioScheduler(ctx);
    s.start(5, 10.2);
    expect(s.mediaTime()).toBe(5);
    ctx.currentTime = 11.25;
    expect(s.mediaTime()).toBeCloseTo(6);
  });

  it('stops every scheduled node', () => {
    const { ctx, nodes } = fakeCtx(10);
    const s = new AudioScheduler(ctx);
    s.start(0, 10);
    s.schedule(chunk(0));
    s.schedule(chunk(0.1));
    s.stop();
    expect(nodes.every((n) => n.stopped)).toBe(true);
  });
});
