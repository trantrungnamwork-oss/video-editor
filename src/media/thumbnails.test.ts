import { describe, expect, it } from 'vitest';
import { thumbnailSlots } from './thumbnails';

describe('thumbnailSlots', () => {
  it('places slot centres evenly', () => {
    expect(thumbnailSlots(10, 4)).toEqual([1.25, 3.75, 6.25, 8.75]);
  });
  it('handles degenerate input', () => {
    expect(thumbnailSlots(0, 4)).toEqual([]);
    expect(thumbnailSlots(10, 0)).toEqual([]);
    expect(thumbnailSlots(Number.NaN, 3)).toEqual([]);
  });
});
