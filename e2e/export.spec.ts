import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { probeMedia } from '../src/media/probe';
import { openWithTestClips, scrubTo, stat } from './helpers';
import { meanLuma } from './png';

const CLIP_SEC = 3;
const anyDecoder = { isConfigSupported: () => Promise.resolve({ supported: true }) };

async function expectedFormat(page: Page) {
  // The app must pick MP4 exactly when this browser can encode H.264 + AAC at 720p.
  const mp4 = await page.evaluate(async () => {
    const [v, a] = await Promise.all([
      VideoEncoder.isConfigSupported({
        codec: 'avc1.64001f',
        width: 1280,
        height: 720,
        bitrate: 5e6,
      }),
      AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 160000,
      }),
    ]);
    return !!v.supported && !!a.supported;
  });
  return mp4 ? 'mp4' : 'webm';
}

const previewLuma = async (page: Page) =>
  meanLuma(await page.getByTestId('preview-canvas').screenshot());

test('exports the edited timeline with the right content', async ({ page, browser }) => {
  await openWithTestClips(page, 2, CLIP_SEC);
  // Timeline: A[0, 1.5) + B[0, 3) = 4.5 s. Test clips flash white for 3 frames every second.
  await scrubTo(page, 1.5);
  await page.getByRole('button', { name: 'Split at playhead' }).click();
  await page.getByTestId('timeline-clip').nth(1).click(); // middle: the neighbour's trim handle overlaps its start
  await page.getByRole('button', { name: 'Delete clip' }).click();
  await expect(page.getByTestId('timeline-clip')).toHaveCount(2);

  await page.getByTestId('open-export').click();
  const format = await expectedFormat(page);
  await expect(page.getByTestId('export-format')).toContainText(format === 'mp4' ? 'MP4' : 'WebM');
  await expect(page.getByLabel('1080p')).toBeDisabled(); // 720p sources are never upscaled
  await page.getByTestId('export-start').click();
  await expect(page.getByTestId('export-progress')).toBeVisible();
  await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 120_000 });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-download').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(new RegExp(`^video-\\d{8}-\\d{6}\\.${format}$`));
  const bytes = await readFile((await download.path()) ?? '');

  const info = await probeMedia(new Blob([bytes]), 'out', {
    VideoDecoder: anyDecoder,
    AudioDecoder: anyDecoder,
  });
  expect(info.durationSec).toBeCloseTo(4.5, 1);
  expect(info.video).toMatchObject({ displayWidth: 1280, displayHeight: 720, frameRate: 30 });
  expect(info.video.codec).toBe(format === 'mp4' ? 'avc' : 'vp9');
  expect(info.audio).toMatchObject({
    codec: format === 'mp4' ? 'aac' : 'opus',
    sampleRate: 48_000,
    channels: 2,
  });

  // Re-open the exported file alone and check that the frames landed where the edit put them.
  const ctx = await browser.newContext();
  const check = await ctx.newPage();
  await check.goto('/');
  await check.getByTestId('file-input').setInputFiles({
    name: download.suggestedFilename(),
    mimeType: format === 'mp4' ? 'video/mp4' : 'video/webm',
    buffer: bytes,
  });
  await expect(check.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 30_000 });
  await check.getByTestId('stats').locator('summary').click();
  for (const [t, flash] of [
    [0.02, true], // A frame 0
    [1.4, false], // A frame 42
    [1.52, true], // B frame 0, right after the cut
    [2.52, true], // B frame 30
    [3.2, false],
  ] as const) {
    await scrubTo(check, t);
    await expect.poll(() => stat(check, 'shown')).toBeCloseTo(t, 1);
    const luma = await previewLuma(check);
    if (flash) expect(luma, `t=${t}`).toBeGreaterThan(180);
    else expect(luma, `t=${t}`).toBeLessThan(120);
  }
  await ctx.close();
});

test('cancels an export and cleans up the partial file', async ({ page }) => {
  await openWithTestClips(page, 2, 6);
  await page.getByTestId('open-export').click();
  await page.getByTestId('export-start').click();
  await expect
    .poll(async () =>
      Number(await page.getByTestId('export-progress').getAttribute('aria-valuenow')),
    )
    .toBeGreaterThan(0);
  await page.getByTestId('export-cancel').click();
  await expect(page.getByTestId('export-start')).toBeVisible();

  const files = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('exports', { create: true });
    const names: string[] = [];
    for await (const n of (dir as unknown as { keys(): AsyncIterable<string> }).keys())
      names.push(n);
    return names;
  });
  expect(files).toEqual([]);
});
