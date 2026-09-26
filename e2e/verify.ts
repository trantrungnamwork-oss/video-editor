import { readFile } from 'node:fs/promises';
import { expect, type Browser } from '@playwright/test';
import { probeMedia, type MediaInfo } from '../src/media/probe';
import { scrubTo, stat } from './helpers';
import { meanLuma } from './png';

const anyDecoder = { isConfigSupported: () => Promise.resolve({ supported: true }) };

export async function probeFile(path: string): Promise<MediaInfo> {
  const bytes = await readFile(path);
  return probeMedia(new Blob([bytes]), path, {
    VideoDecoder: anyDecoder,
    AudioDecoder: anyDecoder,
  });
}

/**
 * Opens `path` alone in a fresh page and checks, frame by frame, whether the preview shows a test
 * clip's white flash (frames 0–2 of every second) at the given timeline times.
 */
export async function expectFlashes(
  browser: Browser,
  path: string,
  checks: readonly (readonly [number, boolean])[],
) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(path);
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('stats').locator('summary').click();
  for (const [t, flash] of checks) {
    await scrubTo(page, t);
    await expect.poll(() => stat(page, 'shown')).toBeCloseTo(t, 1);
    const luma = meanLuma(await page.getByTestId('preview-canvas').screenshot());
    if (flash) expect(luma, `t=${t} should be a flash`).toBeGreaterThan(180);
    else expect(luma, `t=${t} should be dark`).toBeLessThan(120);
  }
  await ctx.close();
}
