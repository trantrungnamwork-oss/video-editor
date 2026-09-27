import { expect, test } from '@playwright/test';
import { createSyntheticVideo } from '../src/media/testing/syntheticMedia';

const upload = async (
  page: import('@playwright/test').Page,
  files: { name: string; mimeType: string; buffer: Buffer }[],
) => page.getByTestId('file-input').setInputFiles(files);

test('imports clips and shows their metadata', async ({ page }) => {
  const [webm, portrait] = await Promise.all([
    createSyntheticVideo({
      container: 'webm',
      video: 'vp9',
      audio: 'opus',
      width: 1280,
      height: 720,
      fps: 25,
    }),
    createSyntheticVideo({ container: 'mov', video: 'hevc', audio: 'aac', rotation: 90, fps: 30 }),
  ]);
  await page.goto('/');
  await upload(page, [
    { name: 'landscape.webm', mimeType: 'video/webm', buffer: Buffer.from(webm) },
    { name: 'portrait.mov', mimeType: 'video/quicktime', buffer: Buffer.from(portrait) },
  ]);

  const cards = page.getByTestId('media-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute('data-status', 'ready');
  await expect(cards.nth(1)).toHaveAttribute('data-status', 'ready');

  await expect(cards.nth(0)).toContainText('1280×720');
  await expect(cards.nth(0)).toContainText('25 fps');
  await expect(cards.nth(0)).toContainText('VP9');
  await expect(cards.nth(0)).toContainText('Opus 48 kHz 2ch');
  await expect(cards.nth(1)).toContainText('1080×1920');
  await expect(cards.nth(1)).toContainText('HEVC');
});

test('decodability warning matches the browser decoder', async ({ page }) => {
  const mp4 = await createSyntheticVideo({ container: 'mp4', video: 'avc', audio: 'aac' });
  await page.goto('/');
  await upload(page, [{ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from(mp4) }]);

  const card = page.getByTestId('media-card');
  await expect(card).toHaveAttribute('data-status', 'ready');
  const supported = await page.evaluate(async () => {
    const { supported } = await VideoDecoder.isConfigSupported({
      codec: 'avc1.640028',
      codedWidth: 1920,
      codedHeight: 1080,
      description: new Uint8Array([1, 0x64, 0x00, 0x28, 0xff, 0xe0, 0x00]),
    });
    return supported === true;
  });
  const alert = card.getByRole('alert');
  if (supported) await expect(alert).toHaveCount(0);
  else await expect(alert).toContainText("can't decode H.264");
});

test('rejects non-video files and allows removing them', async ({ page }) => {
  await page.goto('/');
  await upload(page, [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('definitely not a video') },
  ]);
  const card = page.getByTestId('media-card');
  await expect(card).toHaveAttribute('data-status', 'error');
  await expect(card.getByRole('alert')).toContainText('Unsupported file format');

  const remove = card.getByRole('button', { name: /Remove/ });
  expect((await remove.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await remove.click();
  await expect(page.getByTestId('media-card')).toHaveCount(0);
});
