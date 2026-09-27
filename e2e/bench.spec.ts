import { expect, test } from '@playwright/test';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('benchmark page measures a re-encode and a lossless export', async ({ page }) => {
  await page.goto('/bench?auto=1&clip=640x360x3@30');
  await expect(page.getByTestId('bench-json')).toBeVisible({ timeout: 120_000 });
  const run = JSON.parse((await page.getByTestId('bench-json').textContent()) ?? '{}') as {
    version: string;
    results: {
      mode: string;
      sourceSec: number;
      exportSec: number;
      memoryMethod: string;
      peakMemoryBytes: number | null;
    }[];
  };
  expect(run.version).toMatch(/^\d+\.\d+\.\d+\+/);
  expect(run.results.map((r) => r.mode)).toEqual(['reencode', 'original']);
  for (const r of run.results) {
    expect(r.sourceSec).toBeCloseTo(3, 0);
    expect(r.exportSec).toBeGreaterThan(0);
    // Headless Chromium refuses the precise API, so the sampler must fall back, not give up.
    expect(['measureUserAgentSpecificMemory', 'performance.memory']).toContain(r.memoryMethod);
    expect(r.peakMemoryBytes).toBeGreaterThan(0);
  }

  // Copy gives feedback and puts the Markdown rows plus JSON on the clipboard.
  await page.getByTestId('bench-copy').click();
  await expect(page.getByTestId('bench-copy')).toHaveText('Copied!');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('| Re-encode |');
});

test('the benchmark is reachable from the device report (no address bar in the installed app)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Device report' }).click();
  await page.getByTestId('open-bench').click();
  await expect(page.getByRole('heading', { name: 'Export benchmark' })).toBeVisible();
  await expect(page.getByTestId('bench-run')).toBeEnabled();
});
