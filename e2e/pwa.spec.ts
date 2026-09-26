import { expect, test } from '@playwright/test';

test('manifest meets install criteria', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const manifest = (await (await request.get(new URL(href ?? '', page.url()).href)).json()) as {
    name: string;
    display: string;
    start_url: string;
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
  };
  expect(manifest).toMatchObject({ display: 'standalone', start_url: '/' });
  const sizes = manifest.icons.filter((i) => i.type === 'image/png').map((i) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  for (const icon of manifest.icons) {
    const res = await request.get(`/${icon.src}`);
    expect(res.ok(), icon.src).toBe(true);
  }
  expect((await request.get('/apple-touch-icon.png')).ok()).toBe(true);
});

test('works offline after the first visit', async ({ page, context }) => {
  await page.goto('/');
  // Wait until the service worker controls the page and has precached the app.
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) =>
        navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }),
      );
    }
    return reg.active?.state;
  });

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Video Editor' })).toBeVisible();
  // The heavy parts are workers: they must come from the cache too. Encoding a test clip uses the
  // test-clip worker; probing it uses the probe worker; the timeline uses the preview worker.
  await page.getByTestId('add-test-clip').click();
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await page.goto('/debug'); // deep link, served by the SPA fallback from the cache
  await expect(page.getByTestId('report')).toBeVisible({ timeout: 15_000 });
  await context.setOffline(false);
});
