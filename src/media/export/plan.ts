/**
 * Export planning: output size, codecs and bitrate per preset. Pure; the encoder support check
 * itself runs in the export worker and is passed in.
 */

export type Preset = '720p' | '1080p';
export const PRESETS: readonly Preset[] = ['720p', '1080p'];
const SHORT_SIDE: Record<Preset, number> = { '720p': 720, '1080p': 1080 };

export type Container = 'mp4' | 'webm';

/** MVP rule (CLAUDE.md §6.6): MP4 H.264 + AAC, else WebM VP9 + Opus. */
export const FORMATS = [
  { container: 'mp4', video: 'avc', audio: 'aac' },
  { container: 'webm', video: 'vp9', audio: 'opus' },
] as const;
export type Format = (typeof FORMATS)[number];

export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_CHANNELS = 2;
export const AUDIO_BITRATE = 160_000;
export const KEYFRAME_INTERVAL_SEC = 2;

/**
 * Output size for a preset: the preset sets the short side, the first clip's display aspect sets
 * the long side. Never upscales past the source; both sides even (4:2:0 chroma subsampling).
 */
export function outputSize(
  sourceWidth: number,
  sourceHeight: number,
  preset: Preset,
): { width: number; height: number } {
  const shortSrc = Math.min(sourceWidth, sourceHeight);
  const short = Math.min(SHORT_SIDE[preset], shortSrc);
  const scale = short / shortSrc;
  return { width: even(sourceWidth * scale), height: even(sourceHeight * scale) };
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** A preset is offered only if it would not just repeat a smaller one (source too small). */
export function isUpscale(sourceWidth: number, sourceHeight: number, preset: Preset): boolean {
  return SHORT_SIDE[preset] > Math.min(sourceWidth, sourceHeight);
}

/** Video bitrate tuned for phone-shot footage; VP9 needs less than H.264 for similar quality. */
export function videoBitrate(width: number, height: number, fps: number, container: Container) {
  const pixels = width * height;
  const base = pixels <= 1280 * 720 ? 5_000_000 : pixels <= 1920 * 1080 ? 8_000_000 : 16_000_000;
  const fpsFactor = fps > 40 ? 1.5 : 1;
  return Math.round(base * fpsFactor * (container === 'webm' ? 0.7 : 1));
}

export interface PresetPlan {
  preset: Preset;
  width: number;
  height: number;
  /** Null when neither format can be encoded at this size on this device. */
  format: Format | null;
  videoBitrate: number;
  /** Source is smaller than this preset; the output would be identical to a smaller preset. */
  upscale: boolean;
}

export type EncodeSupport = (
  format: Format,
  width: number,
  height: number,
  bitrate: number,
) => Promise<boolean>;

export async function planPresets(
  sourceWidth: number,
  sourceHeight: number,
  fps: number,
  supports: EncodeSupport,
): Promise<PresetPlan[]> {
  const plans: PresetPlan[] = [];
  for (const preset of PRESETS) {
    const { width, height } = outputSize(sourceWidth, sourceHeight, preset);
    let format: Format | null = null;
    for (const f of FORMATS) {
      if (await supports(f, width, height, videoBitrate(width, height, fps, f.container))) {
        format = f;
        break;
      }
    }
    plans.push({
      preset,
      width,
      height,
      format,
      videoBitrate: videoBitrate(width, height, fps, format?.container ?? 'mp4'),
      upscale: isUpscale(sourceWidth, sourceHeight, preset),
    });
  }
  return plans;
}

/** `video-20260926-184512.mp4` */
export function exportFileName(container: Container, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `video-${stamp}.${container}`;
}

/**
 * Remaining time estimate from progress so far. Uses the overall average rate, which is stable
 * enough for a single pass; null until there is enough signal.
 */
export function estimateRemainingSec(elapsedSec: number, fraction: number): number | null {
  if (fraction < 0.02 || elapsedSec < 1) return null;
  return Math.max(0, (elapsedSec * (1 - fraction)) / fraction);
}
