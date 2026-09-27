import { copyFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { finishExportAndDownload, openWithTestClips, startReencodeExport, stat } from './helpers';
import { expectFlashes, probeFile } from './verify';

// Two 6 s test clips = 12 s = two 10 s export segments.
const FLASH_CHECKS = [
  [0.02, true],
  [5.9, false],
  [6.02, true], // second clip starts
  [9.9, false],
  [10.02, true], // first frame of the second export segment
  [11.5, false],
] as const;

test.setTimeout(240_000);

const progress = async (page: import('@playwright/test').Page) =>
  Number(await page.getByTestId('export-progress').getAttribute('aria-valuenow'));

test('pauses on an interrupted segment and resumes by itself', async ({ page, browser }) => {
  // Segment 1 fails once, as when the browser reclaims the encoder of a background tab.
  await openWithTestClips(page, 2, 6, '&exportfault=1');
  await page.getByTestId('open-export').click();
  await startReencodeExport(page);
  // The paused state lasts under a second before auto-resume; watch every frame so it's not missed.
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="export-paused"]'),
    null,
    {
      polling: 'raf',
      timeout: 90_000,
    },
  );
  const out = await finishExportAndDownload(page);

  expect((await probeFile(out.path)).durationSec).toBeCloseTo(12, 1);
  await expectFlashes(browser, out.path, FLASH_CHECKS);
});

test('resumes after the page is reloaded mid-export', async ({ page, browser }, testInfo) => {
  // A real file on disk, so it can be selected again after the reload with the same identity.
  await openWithTestClips(page, 2, 6);
  await page.getByTestId('open-export').click();
  await startReencodeExport(page);
  const source = testInfo.outputPath('source.webm');
  await copyFile((await finishExportAndDownload(page)).path, source);

  const ctx = await browser.newContext();
  const editor = await ctx.newPage();
  editor.on('dialog', (d) => void d.accept()); // the "leave page?" prompt during export
  await editor.goto('/');
  await editor.getByTestId('file-input').setInputFiles(source);
  await expect(editor.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 30_000 });
  await editor.getByTestId('open-export').click();
  await startReencodeExport(editor);
  // Past the first segment's checkpoint (audio 5 % + first video segment 45 %). Checked every
  // frame: the rest of the export can finish within a second, so a slow poll could miss it.
  await editor.waitForFunction(
    () =>
      Number(
        document.querySelector('[data-testid="export-progress"]')?.getAttribute('aria-valuenow'),
      ) >= 55,
    null,
    { polling: 'raf', timeout: 90_000 },
  );

  await editor.reload(); // what the OS killing the tab looks like to the app
  await expect(editor.getByTestId('missing-banner')).toBeVisible();
  await expect(editor.getByTestId('timeline-clip')).toHaveCount(1); // project restored
  await expect(editor.getByTestId('resume-banner')).toBeVisible();
  await expect(editor.getByTestId('resume-export')).toBeDisabled();

  await editor.getByTestId('file-input').setInputFiles(source);
  await expect(editor.getByTestId('missing-banner')).toHaveCount(0, { timeout: 30_000 });
  await editor.getByTestId('resume-export').click();
  // Continues from the checkpoint instead of starting over.
  expect(await progress(editor)).toBeGreaterThanOrEqual(45);
  const out = await finishExportAndDownload(editor);
  await expect(editor.getByTestId('resume-banner')).toHaveCount(0);

  expect((await probeFile(out.path)).durationSec).toBeCloseTo(12, 1);
  await expectFlashes(browser, out.path, FLASH_CHECKS);
  await ctx.close();
});

test('starts a new project from the relink banner', async ({ page }) => {
  await openWithTestClips(page, 1, 2);
  await page.reload(); // generated test clips can't be re-selected: they stay missing
  await expect(page.getByTestId('missing-banner')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('missing-banner')).toHaveCount(0);
  await expect(page.getByTestId('timeline-clip')).toHaveCount(0);
  await expect(page.getByTestId('media-card')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('missing-banner')).toHaveCount(0);
  await expect(page.getByTestId('media-card')).toHaveCount(0);
});

test('picking a library video again renews it instead of duplicating it', async ({
  page,
  browser,
}, testInfo) => {
  await openWithTestClips(page, 1, 2);
  await page.getByTestId('open-export').click();
  await startReencodeExport(page);
  const source = testInfo.outputPath('source.webm');
  await copyFile((await finishExportAndDownload(page)).path, source);

  const ctx = await browser.newContext();
  const editor = await ctx.newPage();
  await editor.goto('/');
  await editor.getByTestId('file-input').setInputFiles(source);
  await expect(editor.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 30_000 });
  await expect(editor.getByTestId('play-toggle')).toBeEnabled();
  await editor.getByTestId('file-input').setInputFiles(source);
  await expect(editor.getByTestId('media-card')).toHaveCount(1);
  await expect(editor.getByTestId('timeline-clip')).toHaveCount(1);
  // The preview reopens the renewed file and still plays.
  await editor.getByTestId('play-toggle').click();
  await editor.getByTestId('stats').locator('summary').click();
  await expect.poll(() => stat(editor, 'shown'), { timeout: 10_000 }).toBeGreaterThan(0.5);
  await ctx.close();
});
