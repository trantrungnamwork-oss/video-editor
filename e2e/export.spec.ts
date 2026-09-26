import { expect, test, type Page } from '@playwright/test';
import {
  finishExportAndDownload,
  openWithTestClips,
  scrubTo,
  startReencodeExport,
} from './helpers';
import { expectFlashes, probeFile } from './verify';

const CLIP_SEC = 3;

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

test('exports the edited timeline with the right content', async ({ page, browser }) => {
  await openWithTestClips(page, 2, CLIP_SEC);
  // Timeline: A[0, 1.5) + B[0, 3) = 4.5 s. Test clips flash white for 3 frames every second.
  await scrubTo(page, 1.5);
  await page.getByRole('button', { name: 'Split at playhead' }).click();
  // Middle of the clip: the neighbour's trim handle overlaps its start.
  await page.getByTestId('timeline-clip').nth(1).click();
  await page.getByRole('button', { name: 'Delete clip' }).click();
  await expect(page.getByTestId('timeline-clip')).toHaveCount(2);

  await page.getByTestId('open-export').click();
  const format = await expectedFormat(page);
  await expect(page.getByLabel('1080p')).toBeDisabled(); // 720p sources are never upscaled
  await expect(page.getByTestId('export-original')).not.toContainText('checking', {
    timeout: 30_000,
  });
  await page.getByLabel('720p').check();
  await expect(page.getByTestId('export-format')).toContainText(format === 'mp4' ? 'MP4' : 'WebM');
  await page.getByTestId('export-start').click();
  await expect(page.getByTestId('export-progress')).toBeVisible();
  const out = await finishExportAndDownload(page);
  expect(out.name).toMatch(new RegExp(`^video-\\d{8}-\\d{6}\\.${format}$`));

  const info = await probeFile(out.path);
  expect(info.durationSec).toBeCloseTo(4.5, 1);
  expect(info.video).toMatchObject({ displayWidth: 1280, displayHeight: 720, frameRate: 30 });
  expect(info.video.codec).toBe(format === 'mp4' ? 'avc' : 'vp9');
  expect(info.audio).toMatchObject({
    codec: format === 'mp4' ? 'aac' : 'opus',
    sampleRate: 48_000,
    channels: 2,
  });

  await expectFlashes(browser, out.path, [
    [0.02, true], // A frame 0
    [1.4, false], // A frame 42
    [1.52, true], // B frame 0, right after the cut
    [2.52, true], // B frame 30
    [3.2, false],
  ]);
});

test('cancels an export and cleans up the partial files', async ({ page }) => {
  await openWithTestClips(page, 2, 6);
  await page.getByTestId('open-export').click();
  await startReencodeExport(page);
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
    const walk = async (d: FileSystemDirectoryHandle, prefix: string) => {
      const entries = (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
      for await (const e of entries) {
        if (e.kind === 'directory')
          await walk(e as FileSystemDirectoryHandle, `${prefix}${e.name}/`);
        else names.push(prefix + e.name);
      }
    };
    await walk(dir, '');
    return names;
  });
  expect(files).toEqual([]);
});
