/**
 * Draws one output frame. Shared by the preview worker (at screen size) and the export (at output
 * size), so what the preview shows is what gets encoded (ADR 0012). Canvas 2D: GPU-backed in
 * Chromium and WebKit, and enough for video placement, text, images and filters.
 */
import type { VideoSample } from 'mediabunny';
import { coverCrop, DEFAULT_LAYOUT, type ClipLayout } from '../../core/frame';

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export const BACKGROUND = '#000';

/** Clears the frame and draws a clip's picture placed by its layout. */
export function drawFrame(
  ctx: Ctx,
  sample: VideoSample | null,
  layout: ClipLayout = DEFAULT_LAYOUT,
) {
  const { width, height } = ctx.canvas;
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  if (!sample) return;
  if (layout.fit === 'cover') {
    const crop = coverCrop(
      sample.displayWidth,
      sample.displayHeight,
      width,
      height,
      layout.panX,
      layout.panY,
    );
    // Mediabunny wants whole pixels inside the picture.
    const w = Math.max(1, Math.min(sample.displayWidth, Math.round(crop.width)));
    const h = Math.max(1, Math.min(sample.displayHeight, Math.round(crop.height)));
    const left = Math.min(sample.displayWidth - w, Math.max(0, Math.round(crop.left)));
    const top = Math.min(sample.displayHeight - h, Math.max(0, Math.round(crop.top)));
    sample.drawWithFit(ctx, { fit: 'fill', crop: { left, top, width: w, height: h } });
  } else {
    sample.drawWithFit(ctx, { fit: 'contain' });
  }
}
