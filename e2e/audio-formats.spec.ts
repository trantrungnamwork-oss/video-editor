import { expect, test } from '@playwright/test';
import { finishExportAndDownload, startReencodeExport } from './helpers';
import { probeFile } from './verify';

// Field bug: a phone video with 22.05 kHz audio failed to export ("Audio parameters must remain
// constant"). Sources at other rates / mono must be converted to 48 kHz stereo on export.
// The failure needs a rate change mid-export (48 kHz clip, then a 22.05 kHz one). 24 kHz mono
// stands in for 22.05 kHz because the browser's Opus encoder (WebM test clips) accepts it.

const MIXED = '/?testclip=1280x720x3@30,1280x720x3@30:24000:1';

async function openMixed(page: import('@playwright/test').Page) {
  await page.goto(MIXED);
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('add-test-clip').click();
    await expect(page.getByTestId('add-test-clip')).toHaveText('Add test clip', {
      timeout: 60_000,
    });
  }
  await expect(page.getByTestId('timeline-clip')).toHaveCount(2, { timeout: 30_000 });
}

test('re-encode export of a 48 kHz stereo clip followed by a 24 kHz mono clip', async ({
  page,
}) => {
  await openMixed(page);
  await page.getByTestId('open-export').click();
  await startReencodeExport(page);
  const out = await finishExportAndDownload(page);
  const info = await probeFile(out.path);
  expect(info.durationSec).toBeCloseTo(6, 1);
  expect(info.audio).toMatchObject({ sampleRate: 48_000, channels: 2 });
});

test('lossless export of a 48 kHz stereo clip followed by a 24 kHz mono clip', async ({ page }) => {
  await openMixed(page);
  await page.getByTestId('open-export').click();
  const original = page.getByTestId('export-original').getByRole('radio');
  await expect(original).toBeChecked({ timeout: 30_000 });
  await page.getByTestId('export-start').click();
  const out = await finishExportAndDownload(page);
  const info = await probeFile(out.path);
  expect(info.durationSec).toBeCloseTo(6, 1);
  expect(info.audio).toMatchObject({ sampleRate: 48_000, channels: 2 });
});
