import { expect, type Page } from '@playwright/test';

export const FPS = 30;

/** Collects main-thread long tasks (>50 ms) into window.__longTasks. Call before page.goto. */
export async function observeLongTasks(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longTasks.push(e.duration);
      }).observe({ type: 'longtask', buffered: false });
    } catch {
      // longtask entries unsupported: assertions become vacuous.
    }
  });
}

export const takeLongTasks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks.splice(0));

/** Encodes `count` test clips on the device and waits until they are all on the timeline. */
export async function openWithTestClips(
  page: Page,
  count: number,
  durationSec: number,
  extraQuery = '',
) {
  await page.goto(`/?testclip=1280x720x${durationSec}@${FPS}${extraQuery}`);
  for (let i = 0; i < count; i++) {
    await page.getByTestId('add-test-clip').click();
    await expect(page.getByTestId('add-test-clip')).toHaveText('Add test clip', {
      timeout: 60_000,
    });
  }
  await expect(page.getByTestId('timeline-clip')).toHaveCount(count, { timeout: 30_000 });
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await page.getByTestId('stats').locator('summary').click();
}

export const stat = (page: Page, name: string) =>
  page
    .getByTestId(`stat-${name}`)
    .textContent()
    .then((t) => Number(t));

/** Scrubs the timeline like a user scroll, then waits for the exact frame. */
export async function scrubTo(page: Page, t: number) {
  const pps = Number(await page.getByTestId('timeline').getAttribute('data-pps'));
  await page.getByTestId('timeline-viewport').evaluate(
    (el, x) => {
      el.scrollLeft = x;
    },
    Math.round(t * pps),
  );
  await expect.poll(() => stat(page, 'shown')).toBeCloseTo(t, 1);
}

export async function timelinePps(page: Page) {
  return Number(await page.getByTestId('timeline').getAttribute('data-pps'));
}

export const clipIds = (page: Page) =>
  page
    .getByTestId('timeline-clip')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-clip-id') ?? ''));

export const clipLabels = (page: Page) => page.getByTestId('clip-duration').allInnerTexts();

/** Runs an export from an open dialog and returns the downloaded file. */
export async function finishExportAndDownload(page: Page) {
  await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 150_000 });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-download').click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error('download has no path');
  return { name: download.suggestedFilename(), path };
}

/** In an open export dialog: waits for the smart-cut analysis, then picks a re-encode preset. */
export async function startReencodeExport(page: Page, preset: '720p' | '1080p' = '720p') {
  await expect(page.getByTestId('export-original')).not.toContainText('checking', {
    timeout: 30_000,
  });
  await page.getByLabel(preset).check();
  await page.getByTestId('export-start').click();
}
