import { expect, test } from '@playwright/test';
import { FPS, observeLongTasks, openWithTestClips, scrubTo, stat, takeLongTasks } from './helpers';

const DURATION = 4;

test.beforeEach(async ({ page }) => observeLongTasks(page));

test('plays to the end with audio, bounded frames and a responsive main thread', async ({
  page,
}) => {
  await openWithTestClips(page, 1, DURATION);
  await expect(page.getByTestId('stat-canvas')).not.toHaveText(/^(0×0|300×150)$/);
  await expect(page.getByTestId('timeline-clip').locator('img').first()).toBeVisible({
    timeout: 30_000,
  });
  // Thumbnails were persisted to the OPFS cache (manifest is written last, as a commit marker).
  const cachedClips = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('thumbnails');
    let n = 0;
    const entries = (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
    for await (const entry of entries) {
      if (entry.kind !== 'directory') continue;
      await (entry as FileSystemDirectoryHandle).getFileHandle('manifest.json');
      n++;
    }
    return n;
  });
  expect(cachedClips).toBe(1);
  await takeLongTasks(page);

  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-toggle')).toHaveText('Play', {
    timeout: DURATION * 1000 + 5000,
  });
  await expect(page.getByTestId('current-time')).toHaveText(`0:0${DURATION}.0`);

  expect(await takeLongTasks(page)).toEqual([]);
  await expect.poll(() => stat(page, 'decoded')).toBeGreaterThanOrEqual(DURATION * FPS * 0.9);
  expect(await stat(page, 'dropped')).toBeLessThan(DURATION * FPS * 0.25);
  expect(await stat(page, 'peak-open')).toBeLessThanOrEqual(9); // read-ahead 6 + shown + primed
  await expect.poll(() => stat(page, 'open-frames')).toBeLessThanOrEqual(1);
  expect(await stat(page, 'audio')).toBeGreaterThan(0);
  expect(await stat(page, 'audio-late')).toBe(0);
});

test('scrubs and steps frame-accurately', async ({ page }) => {
  await openWithTestClips(page, 1, DURATION);
  await scrubTo(page, DURATION / 2);
  const mid = await stat(page, 'shown');

  await page.getByRole('button', { name: 'Next frame' }).click();
  await expect.poll(() => stat(page, 'shown')).toBeCloseTo(mid + 1 / FPS, 3);

  // Rapid steps accumulate even before the worker answers.
  const prev = page.getByRole('button', { name: 'Previous frame' });
  await prev.click();
  await prev.click();
  await prev.click();
  await expect.poll(() => stat(page, 'shown')).toBeCloseTo(mid - 2 / FPS, 3);
});

test('releases every decoded frame after scrubbing, playing and closing', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  await openWithTestClips(page, 1, DURATION);

  await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(500);
  // Scrubbing while playing pauses and seeks; repeated scrolls coalesce in the worker.
  const viewport = page.getByTestId('timeline-viewport');
  for (let i = 0; i <= 20; i++) {
    await viewport.evaluate((el, x) => (el.scrollLeft = x), i * 10);
  }
  await page.waitForTimeout(500);
  for (let i = 0; i < 5; i++) await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: /^Remove / }).click();
  await expect(page.getByTestId('preview')).toHaveCount(0);
  await expect.poll(() => logs.find((l) => l.includes('[preview] disposed'))).toBeTruthy();
  expect(logs.filter((l) => l.includes('frame leak'))).toEqual([]);
  expect(logs.find((l) => l.includes('[preview] disposed'))).toContain('openFrames=0');
});
