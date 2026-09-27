import { describe, expect, it } from 'vitest';
import {
  detectCapabilities,
  planExport,
  VIDEO_CODEC_STRINGS,
  type CapabilityEnv,
  type CapabilityReport,
  type CodecSupport,
} from './capabilities';

type Predicate = (config: { codec: string; width?: number; codedWidth?: number }) => boolean;

const prober = (pred: Predicate) => ({
  isConfigSupported: (config: { codec: string }) => Promise.resolve({ supported: pred(config) }),
});

const baseEnv = (overrides: Partial<CapabilityEnv> = {}): CapabilityEnv => ({
  crossOriginIsolated: true,
  hasSharedArrayBuffer: true,
  now: () => 0,
  timeoutMs: 50,
  ...overrides,
});

describe('detectCapabilities', () => {
  it('reports no-api for every codec when WebCodecs is missing', async () => {
    const report = await detectCapabilities(baseEnv());
    expect(report.webCodecs.VideoEncoder).toBe(false);
    expect(report.video.h264['1080p'].decode.status).toBe('no-api');
    expect(report.audio.aac.encode.status).toBe('no-api');
    expect(report.exportPlan.container).toBeNull();
  });

  it('probes each codec with a resolution-appropriate codec string', async () => {
    const seen: string[] = [];
    const env = baseEnv({
      VideoDecoder: prober((c) => (seen.push(c.codec), true)),
    });
    const report = await detectCapabilities(env);
    expect(report.video.h264['4k'].codec).toBe(VIDEO_CODEC_STRINGS.h264['4k']);
    expect(new Set(seen).size).toBe(12); // 4 codecs x 3 resolutions
  });

  it('picks MP4 when H.264 and AAC encoders exist, capped at the max encodable resolution', async () => {
    const env = baseEnv({
      VideoEncoder: prober((c) => c.codec.startsWith('avc1') && (c.width ?? 0) <= 1920),
      AudioEncoder: prober(() => true),
    });
    const { exportPlan } = await detectCapabilities(env);
    expect(exportPlan).toEqual({
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      maxResolution: '1080p',
      isFallback: false,
    });
  });

  it('falls back to WebM when there is no AAC encoder', async () => {
    const env = baseEnv({
      VideoEncoder: prober(() => true),
      AudioEncoder: prober((c) => c.codec === 'opus'),
    });
    const { exportPlan } = await detectCapabilities(env);
    expect(exportPlan.container).toBe('webm');
    expect(exportPlan.isFallback).toBe(true);
  });

  it('maps TypeError to unsupported, other errors to error, and hangs to timeout', async () => {
    const env = baseEnv({
      VideoDecoder: { isConfigSupported: () => Promise.reject(new TypeError('bad codec')) },
      VideoEncoder: { isConfigSupported: () => Promise.reject(new Error('boom')) },
      AudioDecoder: { isConfigSupported: () => new Promise(() => {}) },
    });
    const report = await detectCapabilities(env);
    expect(report.video.vp9['720p'].decode.status).toBe('unsupported');
    expect(report.video.vp9['720p'].encode).toEqual({ status: 'error', error: 'boom' });
    expect(report.audio.opus.decode.status).toBe('timeout');
  });

  it('detects platform features without touching the user agent', async () => {
    const file = { name: 'x' };
    const env = baseEnv({
      navigator: {
        userAgent: 'SHOULD-NOT-MATTER',
        wakeLock: {} as WakeLock,
        share: () => Promise.resolve(),
        canShare: (data?: ShareData) => (data?.files?.length ?? 0) > 0,
        storage: {
          getDirectory: () => Promise.resolve(file),
          estimate: () => Promise.resolve({ quota: 1e9, usage: 1e6 }),
        } as unknown as StorageManager,
      },
      probeWorker: () =>
        Promise.resolve({
          opfsSyncAccessHandle: { status: 'supported' },
          offscreenCanvas: { status: 'supported' },
          webCodecs: { status: 'no-api' },
        }),
    });
    const { features, storage } = await detectCapabilities(env);
    expect(features.crossOriginIsolated.status).toBe('supported');
    expect(features.opfs.status).toBe('supported');
    expect(features.opfsSyncAccessHandle.status).toBe('supported');
    expect(features.webCodecsInWorker.status).toBe('no-api');
    expect(features.wakeLock.status).toBe('supported');
    expect(features.webShareFiles.status).toBe('supported');
    expect(storage).toEqual({ quotaBytes: 1e9, usageBytes: 1e6 });
  });

  it('reports missing features and a failing worker', async () => {
    const env = baseEnv({
      crossOriginIsolated: false,
      hasSharedArrayBuffer: false,
      navigator: {},
      probeWorker: () => Promise.reject(new Error('worker blocked')),
    });
    const { features } = await detectCapabilities(env);
    expect(features.crossOriginIsolated.status).toBe('unsupported');
    expect(features.sharedArrayBuffer.status).toBe('no-api');
    expect(features.opfs.status).toBe('no-api');
    expect(features.wakeLock.status).toBe('no-api');
    expect(features.webShare.status).toBe('no-api');
    expect(features.opfsSyncAccessHandle).toEqual({ status: 'error', error: 'worker blocked' });
  });
});

describe('planExport', () => {
  const s = (supported: boolean) => ({ status: supported ? 'supported' : 'unsupported' }) as const;
  const cs = (enc: boolean): CodecSupport => ({ codec: 'x', decode: s(true), encode: s(enc) });
  const video = (enc: Partial<Record<keyof CapabilityReport['video'], boolean>>) =>
    Object.fromEntries(
      (['h264', 'hevc', 'vp9', 'av1'] as const).map((id) => [
        id,
        { '720p': cs(!!enc[id]), '1080p': cs(!!enc[id]), '4k': cs(false) },
      ]),
    ) as CapabilityReport['video'];

  it('returns no plan when neither pair is encodable', () => {
    const plan = planExport(video({ h264: true, vp9: true }), { aac: cs(false), opus: cs(false) });
    expect(plan.container).toBeNull();
  });

  it('does not mix codecs across containers', () => {
    // H.264 + Opus is not an MVP combination; VP9 is missing so nothing qualifies.
    const plan = planExport(video({ h264: true }), { aac: cs(false), opus: cs(true) });
    expect(plan.container).toBeNull();
  });
});
