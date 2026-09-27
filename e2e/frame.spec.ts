import { expect, test, type Page } from '@playwright/test';
import { finishExportAndDownload, openWithTestClips, startReencodeExport } from './helpers';
import { exportedGrid, gridDistance, previewGrid, probeFile } from './verify';

// 1280×720 test clips; frame 3 (t=0.1) has a green bar near the left edge, the frame number is
// drawn large in the centre of every frame.
const COLS = 6;
const ROWS = 8;

async function pickAspect(page: Page, label: string) {
  await page.getByTestId('aspect-picker').getByRole('radio', { name: label }).click();
}

async function frameRatio(page: Page) {
  const box = await page.getByTestId('preview-frame').boundingBox();
  return box ? box.width / box.height : 0;
}

test('fills a reshaped frame by default', async ({ page }) => {
  await openWithTestClips(page, 1, 2);
  await pickAspect(page, '9:16');
  const grid = await previewGrid(page, 0.5, COLS, ROWS);
  for (const cell of [...grid.slice(0, COLS), ...grid.slice(-COLS)])
    expect(cell).toBeGreaterThan(8);
});

test('fits all clips with bars, and the export matches the preview', async ({ page, browser }) => {
  await openWithTestClips(page, 1, 2);
  await pickAspect(page, '9:16');
  await page.getByTestId('project-fit').getByRole('radio', { name: 'Fit' }).click();
  await expect.poll(() => frameRatio(page)).toBeCloseTo(9 / 16, 1);

  const preview = await previewGrid(page, 0.5, COLS, ROWS);
  // Fit: the 16:9 picture is a band across the middle, black above and below.
  for (const cell of [...preview.slice(0, COLS * 2), ...preview.slice(-COLS * 2)]) {
    expect(cell).toBeLessThan(8);
  }

  await page.getByTestId('open-export').click();
  const original = page.getByTestId('export-original');
  await expect(original).toContainText('frame shape was changed');
  await expect(original.getByRole('radio')).toBeDisabled();
  await startReencodeExport(page);
  const out = await finishExportAndDownload(page);
  expect((await probeFile(out.path)).video).toMatchObject({
    displayWidth: 720,
    displayHeight: 1280,
  });
  expect(
    gridDistance(preview, await exportedGrid(browser, out.path, 0.5, COLS, ROWS)),
  ).toBeLessThan(30);
});

test('fills the frame with a panned crop, identically in preview and export', async ({
  page,
  browser,
}) => {
  await openWithTestClips(page, 1, 2);
  await pickAspect(page, '9:16');
  await page.getByTestId('timeline-clip').first().click();
  const framing = page.getByTestId('clip-frame-panel');
  // Project fit is Fit; this clip overrides it with Fill.
  await page.getByTestId('project-fit').getByRole('radio', { name: 'Fit' }).click();
  await framing.getByRole('radio', { name: 'Fill' }).click();
  const centred = await previewGrid(page, 0.1, COLS, ROWS);
  // Fill: no bars.
  for (const cell of centred.slice(0, COLS)) expect(cell).toBeGreaterThan(8);

  const slider = framing.getByRole('slider', { name: 'Horizontal position' });
  await slider.focus();
  await slider.press('Home'); // pan fully left
  const left = await previewGrid(page, 0.1, COLS, ROWS);
  expect(gridDistance(centred, left)).toBeGreaterThan(40); // the frame number left the view

  await page.getByTestId('open-export').click();
  await startReencodeExport(page);
  const out = await finishExportAndDownload(page);
  expect(gridDistance(left, await exportedGrid(browser, out.path, 0.1, COLS, ROWS))).toBeLessThan(
    30,
  );
});

test('frame settings are undoable and saved with the project', async ({ page }) => {
  await openWithTestClips(page, 1, 2);
  await pickAspect(page, '1:1');
  await expect.poll(() => frameRatio(page)).toBeCloseTo(1, 1);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => frameRatio(page)).toBeCloseTo(16 / 9, 1);
  await page.getByRole('button', { name: 'Redo' }).click();
  await page.reload();
  await expect(
    page.getByTestId('aspect-picker').getByRole('radio', { name: '1:1' }),
  ).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
});
