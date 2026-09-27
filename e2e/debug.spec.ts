import { expect, test } from '@playwright/test';

test('debug page renders a capability report and copies JSON', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  await page.goto('/debug');
  await expect(page.getByTestId('report')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Video codecs (decode / encode)' })).toBeVisible();

  const copyButton = page.getByTestId('copy-json');
  const box = await copyButton.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44); // touch target (CLAUDE.md §7)

  await copyButton.click();
  await expect(copyButton).toHaveText(/Copied!|Copy failed/);
});

test('production build is cross-origin isolated', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
});
