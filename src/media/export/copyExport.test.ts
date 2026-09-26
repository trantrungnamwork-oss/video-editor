import { describe, expect, it } from 'vitest';
import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  Input,
  type StreamTargetChunk,
} from 'mediabunny';
import { createSyntheticVideo, type SyntheticOptions } from '../testing/syntheticMedia';
import { analyzeCopy, nearest, runCopyExport, type CopyClip } from './copyExport';

const noAudioEncoder = () => Promise.resolve(false);

async function file(name: string, opts: Partial<SyntheticOptions> = {}): Promise<File> {
  const bytes = await createSyntheticVideo({
    container: 'mp4',
    video: 'avc',
    audio: null,
    width: 640,
    height: 360,
    fps: 30,
    durationSec: 4,
    ...opts,
  });
  return new File([bytes as BlobPart], name);
}

const clip = (id: string, f: File, inSec: number, outSec: number): CopyClip => ({
  clipId: id,
  mediaId: f.name,
  file: f,
  inSec,
  outSec,
  hasAudio: false,
});

/** Collects a StreamTarget's positioned writes into one buffer. */
function memoryTarget() {
  let buf = new Uint8Array(0);
  const stream = new WritableStream<StreamTargetChunk>({
    write({ data, position }) {
      const end = position + data.byteLength;
      if (end > buf.length) {
        const next = new Uint8Array(end);
        next.set(buf);
        buf = next;
      }
      buf.set(data, position);
    },
  });
  return { stream, bytes: () => buf };
}

async function packetsOf(bytes: Uint8Array) {
  const input = new Input({
    source: new BlobSource(new Blob([bytes as BlobPart])),
    formats: ALL_FORMATS,
  });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video');
  const out: { ts: number; index: number; key: boolean }[] = [];
  for await (const p of new EncodedPacketSink(track).packets()) {
    out.push({
      ts: Math.round(p.timestamp * 1000) / 1000,
      index: (p.data[0] ?? 0) * 256 + (p.data[1] ?? 0),
      key: p.type === 'key',
    });
  }
  return { out, duration: await input.computeDuration(), config: await track.getDecoderConfig() };
}

describe('nearest', () => {
  it('picks the closest candidate in range, earlier on ties', () => {
    expect(nearest(1.5, [1, 2], 0, 10)).toBe(1);
    expect(nearest(1.6, [1, 2], 0, 10)).toBe(2);
    expect(nearest(1.6, [1, 2], 0, 1.9)).toBe(1);
    expect(nearest(1.6, [1, 2], 3, 4)).toBeNull();
  });
});

describe('analyzeCopy', () => {
  it('accepts cuts on keyframes from compatible streams', async () => {
    const a = await file('a.mp4');
    const b = await file('b.mp4');
    const res = await analyzeCopy([clip('1', a, 1, 2.5), clip('2', b, 0, 4)], noAudioEncoder);
    expect(res).toMatchObject({
      eligible: true,
      container: 'mp4',
      videoCodec: 'avc',
      audioCodec: null,
    });
  });

  it('suggests snapping an in point that is not on a keyframe', async () => {
    const a = await file('a.mp4');
    const res = await analyzeCopy([clip('1', a, 1.5, 4)], noAudioEncoder);
    expect(res.eligible).toBe(false);
    if (res.eligible) return;
    expect(res.reason).toMatch(/1 cut is not on a keyframe/);
    expect(res.snaps).toEqual([{ clipId: '1', inSec: 1, shiftSec: 0.5 }]);
  });

  it('accepts any out point when frames are not reordered, but snaps it when they are', async () => {
    const plain = await file('p.mp4');
    expect((await analyzeCopy([clip('1', plain, 0, 2.5)], noAudioEncoder)).eligible).toBe(true);

    const bframes = await file('b.mp4', { reorder: true });
    const res = await analyzeCopy([clip('1', bframes, 0, 2.7)], noAudioEncoder);
    expect(res.eligible).toBe(false);
    if (res.eligible) return;
    expect(res.snaps).toEqual([
      { clipId: '1', outSec: 3, shiftSec: expect.closeTo(0.3) as number },
    ]);
  });

  it('refuses streams with different settings, and missing audio encoders', async () => {
    const a = await file('a.mp4');
    const wide = await file('w.mp4', { width: 1280, height: 720 });
    const res = await analyzeCopy([clip('1', a, 0, 1), clip('2', wide, 0, 1)], noAudioEncoder);
    expect(res).toMatchObject({ eligible: false, snaps: [] });

    const withAudio = { ...clip('1', a, 0, 1), hasAudio: true };
    const noAac = await analyzeCopy([withAudio], noAudioEncoder);
    expect(noAac).toMatchObject({
      eligible: false,
      reason: expect.stringMatching(/AAC/) as string,
    });
  });
});

describe('runCopyExport', () => {
  it('copies packets byte-for-byte and retimes them onto the timeline', async () => {
    const a = await file('a.mp4');
    const b = await file('b.mp4', { reorder: true });
    const target = memoryTarget();
    await runCopyExport(
      {
        clips: [clip('1', a, 1, 2.5), clip('2', b, 2, 4)],
        container: 'mp4',
        videoCodec: 'avc',
        rotation: 0,
        fileName: 'out.mp4',
      },
      target.stream,
      { signal: new AbortController().signal, onProgress: () => undefined },
    );
    const { out, duration, config } = await packetsOf(target.bytes());
    expect(duration).toBeCloseTo(3.5, 2);
    expect(config?.codec).toBe('avc1.640028');

    // Clip 1: source frames 30..74 (1 s → 2.5 s) at timeline 0 → 1.5 s.
    const first = out.filter((p) => p.ts < 1.5);
    expect(first).toHaveLength(45);
    expect(first[0]).toEqual({ ts: 0, index: 30, key: true });
    // Clip 2 starts with its keyframe at 2 s (frame 60), in decode order, at timeline 1.5 s.
    const second = out.filter((p) => p.ts >= 1.5);
    expect(second[0]).toEqual({ ts: 1.5, index: 60, key: true });
    expect(second.map((p) => p.index).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 60 }, (_, i) => 60 + i),
    );
  });
});
