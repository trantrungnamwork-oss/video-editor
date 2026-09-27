import { expect, test, type Page } from '@playwright/test';
import { finishExportAndDownload, openWithTestClips, startReencodeExport } from './helpers';
import { beepPeaks } from './verify';

// Test clips beep (1 kHz, peak 0.3) for the first 0.1 s of every second.
const BEEP = 0.3;

async function setSlider(page: Page, name: string, key: string, presses = 1) {
  const slider = page.getByTestId('clip-audio-panel').getByRole('slider', { name });
  await slider.focus();
  for (let i = 0; i < presses; i++) await slider.press(key);
}

async function editAudio(page: Page) {
  // Two 3 s clips: A muted, B at 200 % with a 2 s fade-out.
  await page.getByTestId('timeline-clip').nth(0).click();
  await page.getByRole('button', { name: /Mute/ }).click();
  await expect(page.getByTestId('clip-audio-badge')).toHaveText('🔇');

  await page.getByTestId('timeline-clip').nth(1).click();
  await setSlider(page, 'Volume', 'End');
  await setSlider(page, 'Fade out', 'ArrowRight', 20);
  const panel = page.getByTestId('clip-audio-panel');
  await expect(panel).toContainText('200%');
  await expect(panel).toContainText('2.0 s');
  await expect(page.getByTestId('clip-audio-badge').nth(1)).toHaveText('200%');
}

function expectEnvelope(peaks: number[]) {
  const near = (v: number | undefined, want: number) => {
    expect(v ?? 0).toBeGreaterThan(want - 0.06);
    expect(v ?? 0).toBeLessThan(want + 0.06);
  };
  // Timeline s 0-2: A muted.
  for (const s of [0, 1, 2]) expect(peaks[s] ?? 0, `second ${s}`).toBeLessThan(0.02);
  near(peaks[3], BEEP * 2); // B at 0 s: full boost
  near(peaks[4], BEEP * 2); // B at 1 s: fade-out just starting (gain 2 → 1.9)
  near(peaks[5], BEEP); // B at 2 s: halfway through the fade (gain 1 → 0.9)
}

test('applies per-clip volume, mute and fades to the exported audio', async ({ page, browser }) => {
  await openWithTestClips(page, 2, 3);
  await editAudio(page);

  // One undo step per committed change; undo/redo restores the settings.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('clip-audio-panel')).toContainText('1.9 s');
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(page.getByTestId('clip-audio-panel')).toContainText('2.0 s');

  await page.getByTestId('open-export').click();
  await startReencodeExport(page);
  const reencoded = await finishExportAndDownload(page);
  expectEnvelope(await beepPeaks(browser, reencoded.path));
});

test('keeps the lossless video copy and re-encodes only the adjusted audio', async ({
  page,
  browser,
}) => {
  await openWithTestClips(page, 2, 3);
  await editAudio(page);
  await page.getByTestId('open-export').click();
  const original = page.getByTestId('export-original').getByRole('radio');
  await expect(original).toBeEnabled({ timeout: 30_000 });
  await expect(original).toBeChecked();
  await page.getByTestId('export-start').click();
  const copied = await finishExportAndDownload(page);
  expectEnvelope(await beepPeaks(browser, copied.path));
});

test('audio settings are saved with the project', async ({ page }) => {
  await openWithTestClips(page, 1, 3);
  await page.getByTestId('timeline-clip').first().click();
  await page.getByRole('button', { name: /Mute/ }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem('video-editor:project');
        return raw ? (JSON.parse(raw) as { project: { clips: { audio?: unknown }[] } }) : null;
      }),
    )
    .toMatchObject({ project: { clips: [{ audio: { muted: true } }] } });
});
