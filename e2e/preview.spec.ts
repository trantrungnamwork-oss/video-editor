import { expect, test, type Page } from '@playwright/test';

const FPS = 30;
const DURATION = 4;

// Collect main-thread long tasks (>50 ms) so tests can assert the main thread stays responsive.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longTasks.push(e.duration);
      }).observe({ type: 'longtask', buffered: false });
    } catch {
      // longtask entries unsupported: the assertion below becomes vacuous.
    }
  });
});

async function openTestClip(page: Page) {
  await page.goto(`/?testclip=1280x720x${DURATION}@${FPS}`);
  await page.getByTestId('add-test-clip').click();
  await expect(page.getByTestId('preview')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await page.getByTestId('stats').locator('summary').click();
  // Backing store follows the element size (× DPR, capped at 1280×720), never the 300×150 default.
  await expect(page.getByTestId('stat-canvas')).not.toHaveText(/^(0×0|300×150)$/);
}

const stat = (page: Page, name: string) =>
  page
    .getByTestId(`stat-${name}`)
    .textContent()
    .then((t) => Number(t));

const longTasks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks.splice(0));

test('plays to the end with audio, bounded frames and a responsive main thread', async ({
  page,
}) => {
  await openTestClip(page);
  await expect(page.locator('[data-testid=thumbnail-strip] img')).toHaveCount(12, {
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
  await longTasks(page);

  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-toggle')).toHaveText('Play', {
    timeout: DURATION * 1000 + 5000,
  });
  await expect(page.getByTestId('current-time')).toHaveText(`0:0${DURATION}.0`);

  expect(await longTasks(page)).toEqual([]);
  await expect.poll(() => stat(page, 'decoded')).toBeGreaterThanOrEqual(DURATION * FPS * 0.9);
  expect(await stat(page, 'dropped')).toBeLessThan(DURATION * FPS * 0.25);
  expect(await stat(page, 'peak-open')).toBeLessThanOrEqual(8); // read-ahead (6) + shown + slack
  await expect.poll(() => stat(page, 'open-frames')).toBeLessThanOrEqual(1);
  expect(await stat(page, 'audio')).toBeGreaterThan(0);
  expect(await stat(page, 'audio-late')).toBe(0);
});

test('seeks and steps frame-accurately', async ({ page }) => {
  await openTestClip(page);
  const box = await page.getByTestId('scrubber').boundingBox();
  if (!box) throw new Error('scrubber not laid out');

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => stat(page, 'shown')).toBeCloseTo(DURATION / 2, 1);
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
  await openTestClip(page);

  const box = await page.getByTestId('scrubber').boundingBox();
  if (!box) throw new Error('scrubber not laid out');
  const y = box.y + box.height / 2;

  await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(500);
  // Scrub while playing: pauses, fast keyframe seeks while dragging, precise seek on release.
  await page.mouse.move(box.x + 5, y);
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) await page.mouse.move(box.x + (box.width * i) / 20, y);
  await page.mouse.up();
  await page.waitForTimeout(500);
  for (let i = 0; i < 5; i++) await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(300);

  await longTasks(page);
  await page.getByRole('button', { name: /^Remove / }).click();
  await expect(page.getByTestId('preview')).toHaveCount(0);
  await expect.poll(() => logs.find((l) => l.includes('[preview] disposed'))).toBeTruthy();
  expect(logs.filter((l) => l.includes('frame leak'))).toEqual([]);
  expect(logs.find((l) => l.includes('[preview] disposed'))).toContain('openFrames=0');
});
