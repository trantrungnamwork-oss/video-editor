import { describe, expect, it } from 'vitest';
import { RESERVE_BYTES, roomFor } from './vault';

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe('roomFor', () => {
  it('keeps 512 MB free on devices with a large quota', () => {
    expect(roomFor(10 * GB, 1 * GB, 8 * GB)).toBe(true); // 1 GB left
    expect(roomFor(10 * GB, 1 * GB, 9 * GB - RESERVE_BYTES + 1)).toBe(false);
  });

  it('scales the reserve down for small quotas so short clips are still kept', () => {
    // A 300 MB quota (private window, test browser): 30 MB reserve.
    expect(roomFor(300 * MB, 10 * MB, 5 * MB)).toBe(true);
    expect(roomFor(300 * MB, 10 * MB, 265 * MB)).toBe(false);
  });
});
