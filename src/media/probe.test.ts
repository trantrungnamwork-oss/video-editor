import { describe, expect, it } from 'vitest';
import { MediaProbeError, probeMedia, type ProbeEnv } from './probe';
import { createSyntheticVideo, type SyntheticOptions } from './testing/syntheticMedia';

const supportsAll: ProbeEnv = {
  VideoDecoder: { isConfigSupported: () => Promise.resolve({ supported: true }) },
  AudioDecoder: { isConfigSupported: () => Promise.resolve({ supported: true }) },
};

async function probe(opts: SyntheticOptions, env: ProbeEnv = supportsAll) {
  const bytes = await createSyntheticVideo(opts);
  return probeMedia(new Blob([bytes as BlobPart]), `clip.${opts.container}`, env);
}

describe('probeMedia', () => {
  it('reads iPhone-style MOV (HEVC + AAC) metadata', async () => {
    const info = await probe({ container: 'mov', video: 'hevc', audio: 'aac', fps: 30 });
    expect(info.container).toMatch(/QuickTime/);
    expect(info.video).toMatchObject({
      codec: 'hevc',
      displayWidth: 1920,
      displayHeight: 1080,
      frameRate: 30,
      isVariableFrameRate: false,
    });
    expect(info.video?.codecString).toMatch(/^(hvc1|hev1)\./);
    expect(info.audio).toMatchObject({ codec: 'aac', sampleRate: 48_000, channels: 2 });
    expect(info.durationSec).toBeCloseTo(2, 1);
    expect(info.canDecode).toBe(true);
    expect(info.warnings).toEqual([]);
  });

  it('reads WebM (VP9 + Opus)', async () => {
    const info = await probe({
      container: 'webm',
      video: 'vp9',
      audio: 'opus',
      width: 1280,
      height: 720,
      fps: 25,
    });
    expect(info.container).toBe('WebM');
    expect(info.video).toMatchObject({ codec: 'vp9', displayWidth: 1280, frameRate: 25 });
    expect(info.audio?.codec).toBe('opus');
  });

  it('accepts MPEG-TS containers (.ts/.mts/.m2ts)', async () => {
    // Demuxing is Mediabunny's (tested upstream); a synthetic TS would need real H.264 slices.
    const { SUPPORTED_INPUT_FORMATS } = await import('./probe');
    const { MPEG_TS } = await import('mediabunny');
    expect(SUPPORTED_INPUT_FORMATS).toContain(MPEG_TS);
  });

  it('swaps display dimensions for rotated portrait video', async () => {
    const info = await probe({ container: 'mp4', video: 'avc', rotation: 90 });
    expect(info.video).toMatchObject({
      codedWidth: 1920,
      codedHeight: 1080,
      displayWidth: 1080,
      displayHeight: 1920,
      rotation: 90,
    });
  });

  it('checks decodability with the track decoder config, including description', async () => {
    const seen: VideoDecoderConfig[] = [];
    const env: ProbeEnv = {
      VideoDecoder: {
        isConfigSupported: (c) => (seen.push(c), Promise.resolve({ supported: false })),
      },
      AudioDecoder: supportsAll.AudioDecoder,
    };
    const info = await probe({ container: 'mp4', video: 'avc', audio: 'aac' }, env);
    expect(seen[0]?.codec).toBe('avc1.640028');
    expect(seen[0]?.description).toBeDefined();
    expect(info.canDecode).toBe(false);
    expect(info.warnings).toContain('video-undecodable');
  });

  it('flags missing audio, undecodable audio and variable frame rate', async () => {
    const noAudio = await probe({ container: 'mp4', video: 'avc', audio: null });
    expect(noAudio.audio).toBeNull();
    expect(noAudio.warnings).toContain('no-audio');

    const badAudio = await probe(
      { container: 'mp4', video: 'avc', audio: 'aac' },
      {
        ...supportsAll,
        AudioDecoder: { isConfigSupported: () => Promise.resolve({ supported: false }) },
      },
    );
    expect(badAudio.canDecode).toBe(true);
    expect(badAudio.warnings).toContain('audio-undecodable');

    const vfr = await probe({
      container: 'mp4',
      video: 'avc',
      variableFrameRate: true,
      durationSec: 5,
    });
    expect(vfr.warnings).toContain('variable-frame-rate');
  });

  it('reports no-api when WebCodecs is unavailable', async () => {
    const info = await probe({ container: 'mp4', video: 'avc', audio: 'aac' }, {});
    expect(info.video?.decode.status).toBe('no-api');
    expect(info.canDecode).toBe(false);
  });

  it('reads audio-only files (music, voice-over) as kind audio', async () => {
    const info = await probeMedia(new Blob([wav(44_100, 1, 1)]), 'song.wav', supportsAll);
    expect(info).toMatchObject({ kind: 'audio', video: null, canDecode: true });
    expect(info.audio).toMatchObject({ sampleRate: 44_100, channels: 1 });
    expect(info.durationSec).toBeCloseTo(1, 2);
  });

  it('rejects non-video files with a typed error', async () => {
    const junk = new Blob([new Uint8Array(4096).fill(7)]);
    await expect(probeMedia(junk, 'junk.bin', supportsAll)).rejects.toMatchObject({
      name: 'MediaProbeError',
      code: 'unsupported-format',
    });
    await expect(probeMedia(junk, 'junk.bin', supportsAll)).rejects.toBeInstanceOf(MediaProbeError);
  });
});

describe('probeMedia I/O', () => {
  /**
   * Node's Blob.stream() emits the whole remainder as a single chunk, which would make every read
   * look like a full-file read. Browsers stream File contents in small chunks; emulate that.
   */
  class BrowserLikeBlob extends Blob {
    override slice(start?: number, end?: number, type?: string): Blob {
      return new BrowserLikeBlob([super.slice(start, end, type)]);
    }
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      const CHUNK = 64 * 1024;
      let pos = 0;
      return new ReadableStream({
        pull: async (ctrl) => {
          if (pos >= this.size) return ctrl.close();
          const buf = await Blob.prototype.slice.call(this, pos, pos + CHUNK).arrayBuffer();
          pos += buf.byteLength;
          ctrl.enqueue(new Uint8Array(buf));
        },
      });
    }
  }

  it.each(['mp4', 'webm'] as const)(
    'reads only a small fraction of a large %s file',
    async (container) => {
      const bytes = await createSyntheticVideo({
        container,
        video: container === 'mp4' ? 'avc' : 'vp9',
        audio: container === 'mp4' ? 'aac' : 'opus',
        durationSec: 60,
        videoPacketBytes: 40_000, // ~72 MB
      });
      let bytesRead = 0;
      const info = await probeMedia(new BrowserLikeBlob([bytes as BlobPart]), `big.${container}`, {
        ...supportsAll,
        onRead: (start, end) => (bytesRead += end - start),
      });
      expect(info.durationSec).toBeCloseTo(60, 0);
      // MP4 needs only the moov box. Matroska has no sample table, so frame-rate estimation
      // walks clusters up to FRAME_RATE_PROBE_PACKETS packets (~10 MB at 1080p/10 Mbps); the data
      // streams through the bounded source cache and is never held at once.
      expect(bytesRead / bytes.byteLength).toBeLessThan(container === 'mp4' ? 0.01 : 0.2);
    },
  );
});

/** Minimal 16-bit PCM WAV of silence. */
function wav(rate: number, channels: number, seconds: number): ArrayBuffer {
  const frames = Math.round(rate * seconds);
  const data = frames * channels * 2;
  const buf = new DataView(new ArrayBuffer(44 + data));
  const str = (o: number, t: string) =>
    [...t].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  buf.setUint32(4, 36 + data, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true); // PCM
  buf.setUint16(22, channels, true);
  buf.setUint32(24, rate, true);
  buf.setUint32(28, rate * channels * 2, true);
  buf.setUint16(32, channels * 2, true);
  buf.setUint16(34, 16, true);
  str(36, 'data');
  buf.setUint32(40, data, true);
  return buf.buffer;
}
