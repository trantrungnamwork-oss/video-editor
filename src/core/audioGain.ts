/**
 * Per-clip gain envelope (volume, mute, linear fades). Pure; the preview worker and the export
 * pipeline apply the same curve, so what you hear is what gets exported.
 */
import type { ClipAudio } from './project';

/** Gain at `t` seconds into a clip of `durationSec`. */
export function gainAt(audio: ClipAudio | undefined, t: number, durationSec: number): number {
  if (!audio) return 1;
  if (audio.muted) return 0;
  let g = audio.volume;
  // When the fades overlap (clip shorter than both), each is limited to half the clip.
  const both = audio.fadeInSec + audio.fadeOutSec > durationSec;
  const fadeIn = both ? Math.min(audio.fadeInSec, durationSec / 2) : audio.fadeInSec;
  const fadeOut = both ? Math.min(audio.fadeOutSec, durationSec / 2) : audio.fadeOutSec;
  if (fadeIn > 0 && t < fadeIn) g *= Math.max(0, t / fadeIn);
  if (fadeOut > 0 && t > durationSec - fadeOut) g *= Math.max(0, (durationSec - t) / fadeOut);
  return g;
}

/** True when the clip contributes no sound at all (its audio need not be decoded). */
export const isSilent = (audio: ClipAudio | undefined) =>
  !!audio && (audio.muted || audio.volume === 0);

/**
 * Multiplies planar samples in place by the clip's envelope. `t0` is the clip-relative time of the
 * first frame. Boosted samples are hard-clipped to [-1, 1].
 */
export function applyGain(
  planes: Float32Array[],
  sampleRate: number,
  t0: number,
  durationSec: number,
  audio: ClipAudio | undefined,
): void {
  if (!audio) return;
  const frames = planes[0]?.length ?? 0;
  const constant =
    audio.fadeInSec === 0 && audio.fadeOutSec === 0 ? gainAt(audio, t0, durationSec) : null;
  if (constant === 1) return;
  for (let i = 0; i < frames; i++) {
    const g = constant ?? gainAt(audio, t0 + i / sampleRate, durationSec);
    for (const plane of planes) {
      const v = (plane[i] ?? 0) * g;
      plane[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  }
}
