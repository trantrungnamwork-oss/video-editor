/**
 * Output frame geometry: project aspect ratio and how each clip sits in the frame. Pure; the
 * compositor (preview and export) and the export planner share it.
 */

export type AspectRatio = 'source' | '16:9' | '9:16' | '1:1' | '4:5';
export const ASPECTS: readonly AspectRatio[] = ['source', '16:9', '9:16', '1:1', '4:5'];

const RATIO: Record<Exclude<AspectRatio, 'source'>, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
};

/** Whole picture with bars ('contain') or filling the frame, cropped ('cover'). */
export type Fit = 'contain' | 'cover';
/** New projects fill the frame (the common expectation on phones: no black bars). */
export const DEFAULT_FIT: Fit = 'cover';

/** How a clip is drawn in the frame (resolved: the clip's override or the project's fit). */
export interface ClipLayout {
  fit: Fit;
  /** -1..1: which part of the picture stays visible when it is cropped (0 = centre). */
  panX: number;
  panY: number;
}

export const DEFAULT_LAYOUT: ClipLayout = { fit: DEFAULT_FIT, panX: 0, panY: 0 };

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/**
 * Frame size for an aspect ratio: 'source' keeps the first clip's display size; otherwise the
 * short side stays the source's short side (so export presets never upscale), both sides even.
 */
export function frameSize(
  aspect: AspectRatio,
  sourceWidth: number,
  sourceHeight: number,
): { width: number; height: number } {
  if (aspect === 'source') return { width: sourceWidth, height: sourceHeight };
  const r = RATIO[aspect];
  const short = Math.min(sourceWidth, sourceHeight);
  return r >= 1
    ? { width: even(short * r), height: even(short) }
    : { width: even(short), height: even(short / r) };
}

/**
 * Source rectangle (in the picture's display pixels) that a `cover` layout shows in a frame of
 * frameW × frameH. The crop has the frame's aspect; pan slides it within the picture.
 */
export function coverCrop(
  pictureW: number,
  pictureH: number,
  frameW: number,
  frameH: number,
  panX: number,
  panY: number,
): { left: number; top: number; width: number; height: number } {
  const scale = Math.max(frameW / pictureW, frameH / pictureH);
  const width = Math.min(pictureW, frameW / scale);
  const height = Math.min(pictureH, frameH / scale);
  const clampPan = (v: number) => Math.min(1, Math.max(-1, v));
  return {
    left: ((pictureW - width) / 2) * (1 + clampPan(panX)),
    top: ((pictureH - height) / 2) * (1 + clampPan(panY)),
    width,
    height,
  };
}
