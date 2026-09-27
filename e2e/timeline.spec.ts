import { expect, test } from '@playwright/test';
import {
  clipIds,
  clipLabels,
  FPS,
  observeLongTasks,
  openWithTestClips,
  scrubTo,
  stat,
  takeLongTasks,
  timelinePps,
} from './helpers';

const CLIP_SEC = 3;

test.beforeEach(async ({ page }) => observeLongTasks(page));


test('split, delete, undo/redo and move', async ({ page }) => {
  await openWithTestClips(page, 2, CLIP_SEC);
  await expect(page.getByTestId('current-time').locator('..')).toContainText('0:06.0');

  await scrubTo(page, 1.5);
  await page.getByRole('button', { name: 'Split at playhead' }).click();
  await expect(page.getByTestId('timeline-clip')).toHaveCount(3);
  expect(await clipLabels(page)).toEqual(['1.5s', '1.5s', '3.0s']);
  await expect(page.getByTestId('timeline-clip').first()).toHaveAttribute('data-selected', 'true');

  await page.getByRole('button', { name: 'Delete clip' }).click();
  await expect(page.getByTestId('timeline-clip')).toHaveCount(2);
  // The player reports the new duration after it has taken the edited sequence.
  await expect(page.getByTestId('current-time').locator('..')).toContainText('0:04.5');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('timeline-clip')).toHaveCount(3);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(page.getByTestId('timeline-clip')).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo' }).click();

  const before = await clipIds(page);
  await page
    .getByTestId('timeline-clip')
    .nth(2)
    .click({ position: { x: 20, y: 10 } });
  await page.getByRole('button', { name: 'Move clip left' }).click();
  expect(await clipIds(page)).toEqual([before[0], before[2], before[1]]);
});

test('trims with the edge handle and reorders by dragging', async ({ page }) => {
  await openWithTestClips(page, 2, CLIP_SEC);
  const first = page.getByTestId('timeline-clip').first();
  await first.click({ position: { x: 20, y: 10 } });

  const handle = first.getByTestId('trim-out');
  const hb = await handle.boundingBox();
  if (!hb) throw new Error('trim handle not laid out');
  expect(hb.width).toBeGreaterThanOrEqual(44);
  expect(hb.height).toBeGreaterThanOrEqual(44);

  // Drag the out point 1 s to the left.
  const pps = await timelinePps(page);
  const y = hb.y + hb.height / 2;
  await page.mouse.move(hb.x + hb.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 - pps / 2, y, { steps: 4 });
  await page.mouse.move(hb.x + hb.width / 2 - pps, y, { steps: 4 });
  await page.mouse.up();
  expect((await clipLabels(page))[0]).toBe('2.0s');
  await expect(page.getByTestId('current-time').locator('..')).toContainText('0:05.0');
  // The preview lands on the last frame of the trimmed clip.
  await expect.poll(() => stat(page, 'shown')).toBeCloseTo(2 - 1 / FPS, 2);

  // Drag the first clip by its grip past the middle of the second one.
  const ids = await clipIds(page);
  const grip = first.getByTestId('clip-grip');
  const gb = await grip.boundingBox();
  if (!gb) throw new Error('grip not laid out');
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb.x + gb.width / 2 + pps * 2.6, gb.y + gb.height / 2, { steps: 8 });
  await expect(page.getByTestId('drop-marker')).toBeVisible();
  await page.mouse.up();
  expect(await clipIds(page)).toEqual([ids[1], ids[0]]);
});

test('plays across a cut without stalls or leaks', async ({ page }) => {
  await openWithTestClips(page, 2, CLIP_SEC);
  await scrubTo(page, 1);
  await page.getByRole('button', { name: 'Split at playhead' }).click();
  await scrubTo(page, 0);
  await takeLongTasks(page);

  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-toggle')).toHaveText('Play', { timeout: 15_000 });
  await expect(page.getByTestId('current-time')).toHaveText('0:06.0');

  expect(await takeLongTasks(page)).toEqual([]);
  expect(await stat(page, 'dropped')).toBeLessThan(2 * CLIP_SEC * FPS * 0.25);
  expect(await stat(page, 'peak-open')).toBeLessThanOrEqual(9);
  await expect.poll(() => stat(page, 'open-frames')).toBeLessThanOrEqual(1);
  expect(await stat(page, 'audio-late')).toBe(0);
  expect(await stat(page, 'inputs')).toBe(2);
});
