import { expect, test } from '@playwright/test';
import { clipLabels, finishExportAndDownload, openWithTestClips, scrubTo } from './helpers';
import { expectFlashes, probeFile } from './verify';

// Test clips are encoded with a keyframe every second.

test('exports keyframe-aligned cuts losslessly without re-encoding', async ({ page, browser }) => {
  await openWithTestClips(page, 2, 3);
  // A[0, 1) + B[0, 3): the cut at 1 s is on a keyframe.
  await scrubTo(page, 1);
  await page.getByRole('button', { name: 'Split at playhead' }).click();
  await page.getByTestId('timeline-clip').nth(1).click();
  await page.getByRole('button', { name: 'Delete clip' }).click();
  expect(await clipLabels(page)).toEqual(['1.0s', '3.0s']);

  await page.getByTestId('open-export').click();
  const original = page.getByTestId('export-original').getByRole('radio');
  await expect(original).toBeEnabled({ timeout: 30_000 });
  await expect(original).toBeChecked(); // lossless is the default when possible
  await expect(page.getByTestId('export-format')).toContainText('copied as recorded');
  await page.getByTestId('export-start').click();
  const out = await finishExportAndDownload(page);

  const info = await probeFile(out.path);
  expect(info.durationSec).toBeCloseTo(4, 1);
  expect(info.video).toMatchObject({ codec: 'vp9', displayWidth: 1280, displayHeight: 720 });
  expect(info.audio).toMatchObject({ codec: 'opus', sampleRate: 48_000 });
  await expectFlashes(browser, out.path, [
    [0.02, true],
    [0.9, false],
    [1.02, true], // B frame 0, right after the join
    [2.02, true],
    [3.5, false],
  ]);
});

test('offers to snap off-keyframe cuts, then exports losslessly', async ({ page }) => {
  await openWithTestClips(page, 1, 3);
  await scrubTo(page, 1.5);
  await page.getByRole('button', { name: 'Split at playhead' }).click();
  expect(await clipLabels(page)).toEqual(['1.5s', '1.5s']);

  await page.getByTestId('open-export').click();
  const original = page.getByTestId('export-original');
  await expect(original).toContainText('1 cut is not on a keyframe', { timeout: 30_000 });
  await expect(original.getByRole('radio')).toBeDisabled();

  // Where the nearest keyframe is depends on the encoder (VP9 also inserts keyframes at scene
  // changes, e.g. where the test clip's white flash ends), so read the promised shift.
  const shift = Number(
    (await page.getByTestId('snap-cuts').textContent())?.match(/([\d.]+) s\)/)?.[1],
  );
  expect(shift).toBeGreaterThan(0);
  expect(shift).toBeLessThanOrEqual(1);
  await page.getByTestId('snap-cuts').click();
  await expect(original.getByRole('radio')).toBeEnabled({ timeout: 30_000 });
  await expect(original.getByRole('radio')).toBeChecked();
  const [firstLabel, secondLabel] = await clipLabels(page);
  expect(firstLabel).toBe('1.5s'); // only the off-keyframe in point moved
  const second = Number(secondLabel?.replace('s', ''));
  expect(Math.abs(second - 1.5)).toBeCloseTo(shift, 1);

  await page.getByTestId('export-start').click();
  const out = await finishExportAndDownload(page);
  expect((await probeFile(out.path)).durationSec).toBeCloseTo(1.5 + second, 1);

  // The snap is a normal edit: undo brings the original cut back.
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  expect(await clipLabels(page)).toEqual(['1.5s', '1.5s']);
});
