import { expect, test } from '@playwright/test';
import {
  finishExportAndDownload,
  openWithTestClips,
  scrubTo,
  startReencodeExport,
} from './helpers';
import { audioPeaks } from './verify';
import { wav } from './wav';

// Test clips beep only in the first 0.1 s of every second, so windows at x.5–x.9 s hear only the
// music (a 440 Hz tone at 0.2) and whatever ducks it.
const MUSIC = 0.2;
const DUCKED = MUSIC * 0.3;
const tone = {
  name: 'tone.wav',
  mimeType: 'audio/wav',
  buffer: wav({ seconds: 2, amplitude: MUSIC }),
};

test.use({ permissions: ['microphone'] });

test('adds looping music and a voice-over that ducks it, in the export', async ({
  page,
  browser,
}) => {
  await openWithTestClips(page, 1, 5);
  await page.getByTestId('music-input').setInputFiles(tone);
  await expect(page.getByTestId('audio-item')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('audio-item').first()).toHaveAttribute('data-kind', 'music');

  // Record ~1.5 s of (silent, fake-mic) voice from 1 s: the preview plays muted meanwhile.
  await scrubTo(page, 1);
  await page.getByTestId('record-voice').click();
  await expect(page.getByTestId('record-voice')).toContainText('Stop recording');
  await page.waitForTimeout(1500);
  await page.getByTestId('record-voice').click();
  const voice = page.locator('[data-testid="audio-item"][data-kind="voice"]');
  await expect(voice).toHaveCount(1, { timeout: 30_000 });
  const start = Number(await voice.getAttribute('data-start'));
  expect(start).toBeGreaterThan(0.9);
  expect(start).toBeLessThan(1.3);

  await page.getByTestId('open-export').click();
  await startReencodeExport(page);
  const out = await finishExportAndDownload(page);
  const [before, during, after, looped] = await audioPeaks(browser, out.path, [
    [0.5, 0.9], // music alone
    [start + 0.5, start + 0.9], // under the voice-over: ducked
    [3.5, 3.9], // after the voice (+ ramp)
    [4.5, 4.9], // the 2 s tone looped a third time
  ]);
  expect(before).toBeGreaterThan(MUSIC - 0.04);
  expect(before).toBeLessThan(MUSIC + 0.04);
  expect(during).toBeGreaterThan(DUCKED - 0.03);
  expect(during).toBeLessThan(DUCKED + 0.03);
  expect(after).toBeGreaterThan(MUSIC - 0.04);
  expect(looped).toBeGreaterThan(MUSIC - 0.04);
});

test('music item settings, delete and reload', async ({ page }) => {
  await openWithTestClips(page, 1, 3);
  await page.getByTestId('music-input').setInputFiles(tone);
  const item = page.getByTestId('audio-item');
  await expect(item).toHaveCount(1, { timeout: 30_000 });
  await item.click();
  const panel = page.getByTestId('audio-item-panel');
  await panel.getByRole('button', { name: /Mute/ }).click();
  await page.reload();
  await expect(page.getByTestId('audio-item')).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('audio-item').click();
  await expect(
    page.getByTestId('audio-item-panel').getByRole('button', { name: /Muted/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Delete music' }).click();
  await expect(page.getByTestId('audio-item')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('audio-item')).toHaveCount(1);
});

test('adds built-in music, generated on the device', async ({ page, browser }) => {
  await openWithTestClips(page, 1, 3);
  await page.getByTestId('add-music').click();
  await page.getByTestId('music-menu').getByRole('menuitem', { name: '♪ Upbeat' }).click();
  await expect(page.getByTestId('audio-item')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('audio-item')).toContainText('Upbeat (built-in)');
  await page.getByTestId('open-export').click();
  await startReencodeExport(page);
  const out = await finishExportAndDownload(page);
  const [music] = await audioPeaks(browser, out.path, [[1.2, 1.9]]);
  expect(music).toBeGreaterThan(0.05);
});
