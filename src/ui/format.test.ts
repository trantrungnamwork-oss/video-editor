import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatFps, videoCodecLabel } from './format';

describe('format', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00.0');
    expect(formatDuration(65.25)).toBe('1:05.3');
    expect(formatDuration(3725)).toBe('1:02:05.0');
  });
  it('formats sizes, fps and codecs', () => {
    expect(formatBytes(512)).toBe('1 KB');
    expect(formatBytes(25_000_000)).toBe('25 MB');
    expect(formatFps(29.97)).toBe('29.97');
    expect(formatFps(30)).toBe('30');
    expect(videoCodecLabel('hevc')).toBe('HEVC');
    expect(videoCodecLabel(null)).toBe('Unknown');
  });
});
