import { describe, expect, it } from 'vitest';
import { coverCrop, frameSize } from './frame';
import {
  addClip,
  aspectOf,
  EMPTY_PROJECT,
  fitOf,
  layoutOf,
  setAspect,
  setClipLayout,
  setProjectFit,
  type Project,
} from './project';

describe('frameSize', () => {
  it('keeps the source shape or reshapes around its short side', () => {
    expect(frameSize('source', 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(frameSize('9:16', 1920, 1080)).toEqual({ width: 1080, height: 1920 });
    expect(frameSize('1:1', 1080, 1920)).toEqual({ width: 1080, height: 1080 });
    expect(frameSize('4:5', 1920, 1080)).toEqual({ width: 1080, height: 1350 });
    expect(frameSize('16:9', 1080, 1920)).toEqual({ width: 1920, height: 1080 });
    expect(frameSize('16:9', 1280, 720)).toEqual({ width: 1280, height: 720 });
  });
});

describe('coverCrop', () => {
  it('crops a landscape picture to a portrait frame, centred or panned', () => {
    // 1920×1080 into 1080×1920: visible part is 607.5×1080 of the picture.
    const c = coverCrop(1920, 1080, 1080, 1920, 0, 0);
    expect(c.width).toBeCloseTo(607.5);
    expect(c.height).toBe(1080);
    expect(c.left).toBeCloseTo((1920 - 607.5) / 2);
    expect(coverCrop(1920, 1080, 1080, 1920, -1, 0).left).toBe(0);
    expect(coverCrop(1920, 1080, 1080, 1920, 1, 0).left).toBeCloseTo(1920 - 607.5);
    expect(coverCrop(1920, 1080, 1080, 1920, 5, 0).left).toBeCloseTo(1920 - 607.5); // clamped
  });

  it('shows the whole picture when the shapes match', () => {
    expect(coverCrop(1280, 720, 1920, 1080, 1, 1)).toEqual({
      left: 0,
      top: 0,
      width: 1280,
      height: 720,
    });
  });
});

const clipOf = (q: Project) => {
  const c = q.clips[0];
  if (!c) throw new Error('no clip');
  return c;
};

describe('project frame settings', () => {
  const p = addClip(EMPTY_PROJECT, { id: 'm', durationSec: 5, frameRate: 30 }, { id: () => 'c' });

  it('sets the aspect ratio and drops it when back to source', () => {
    const q = setAspect(p, '9:16');
    expect(aspectOf(q)).toBe('9:16');
    expect(setAspect(q, '9:16')).toBe(q);
    expect(setAspect(q, 'source')).not.toHaveProperty('aspect');
  });

  it('keeps the aspect through clip edits', () => {
    const q = setAspect(p, '1:1');
    expect(addClip(q, { id: 'n', durationSec: 2, frameRate: 30 }).aspect).toBe('1:1');
  });

  it('fills by default and stores only overrides and pan', () => {
    expect(layoutOf(p, clipOf(p))).toEqual({ fit: 'cover', panX: 0, panY: 0 });
    const q = setClipLayout(p, 'c', { fit: 'contain', panX: 3 });
    expect(q.clips[0]?.layout).toEqual({ fit: 'contain', panX: 1, panY: 0 });
    expect(setClipLayout(q, 'c', { fit: 'contain', panX: 1 })).toBe(q);
    // Back to the project's fit and centred: nothing stored.
    expect(setClipLayout(q, 'c', { fit: 'cover', panX: 0 }).clips[0]).not.toHaveProperty('layout');
  });

  it('sets the fit for the whole project and resets clip overrides, keeping pan', () => {
    const q = setClipLayout(p, 'c', { fit: 'contain', panY: 0.5 });
    const r = setProjectFit(q, 'contain');
    expect(fitOf(r)).toBe('contain');
    expect(r.clips[0]?.layout).toEqual({ panX: 0, panY: 0.5 });
    expect(layoutOf(r, clipOf(r))).toEqual({ fit: 'contain', panX: 0, panY: 0.5 });
    expect(setProjectFit(r, 'contain')).toBe(r);
    expect(setProjectFit(r, 'cover')).not.toHaveProperty('fit');
  });
});
