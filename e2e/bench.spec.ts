import { expect, test } from '@playwright/test';

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
});
