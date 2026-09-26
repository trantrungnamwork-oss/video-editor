import { describe, expect, it } from 'vitest';
import {
  estimateRemainingSec,
  exportFileName,
  outputSize,
  planPresets,
  videoBitrate,
  type EncodeSupport,
} from './plan';

describe('outputSize', () => {
  it('sets the short side from the preset and keeps the aspect', () => {
    expect(outputSize(3840, 2160, '1080p')).toEqual({ width: 1920, height: 1080 });
    expect(outputSize(1080, 1920, '720p')).toEqual({ width: 720, height: 1280 }); // portrait
    expect(outputSize(1440, 1080, '720p')).toEqual({ width: 960, height: 720 }); // 4:3
  });

  it('never upscales and keeps both sides even', () => {
    expect(outputSize(1280, 720, '1080p')).toEqual({ width: 1280, height: 720 });
    expect(outputSize(853, 480, '720p')).toEqual({ width: 854, height: 480 });
  });
});

describe('videoBitrate', () => {
  it('scales with resolution, frame rate and codec', () => {
    expect(videoBitrate(1920, 1080, 30, 'mp4')).toBe(8_000_000);
    expect(videoBitrate(1280, 720, 30, 'mp4')).toBe(5_000_000);
    expect(videoBitrate(1920, 1080, 60, 'mp4')).toBe(12_000_000);
    expect(videoBitrate(1920, 1080, 30, 'webm')).toBe(5_600_000);
  });
});

describe('planPresets', () => {
  it('prefers MP4 and falls back to WebM per preset', async () => {
    // H.264 encoder only up to 720p; VP9 everywhere.
    const supports: EncodeSupport = (f, w, h) =>
      Promise.resolve(f.container === 'webm' || w * h <= 1280 * 720);
    const plans = await planPresets(1920, 1080, 30, supports);
    expect(plans.map((p) => [p.preset, p.format?.container, p.width, p.height])).toEqual([
      ['720p', 'mp4', 1280, 720],
      ['1080p', 'webm', 1920, 1080],
    ]);
  });

  it('marks presets that would upscale and those nothing can encode', async () => {
    const plans = await planPresets(1280, 720, 30, () => Promise.resolve(false));
    expect(plans.map((p) => [p.preset, p.format, p.upscale])).toEqual([
      ['720p', null, false],
      ['1080p', null, true],
    ]);
  });
});

describe('helpers', () => {
  it('names files with a local timestamp', () => {
    expect(exportFileName('mp4', new Date(2026, 8, 26, 18, 5, 9))).toBe(
      'video-20260926-180509.mp4',
    );
  });

  it('estimates remaining time once there is signal', () => {
    expect(estimateRemainingSec(0.5, 0.5)).toBeNull();
    expect(estimateRemainingSec(10, 0.01)).toBeNull();
    expect(estimateRemainingSec(10, 0.25)).toBe(30);
    expect(estimateRemainingSec(10, 1)).toBe(0);
  });
});
