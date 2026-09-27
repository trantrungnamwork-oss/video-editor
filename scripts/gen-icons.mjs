// Renders public/icon.svg to the PNG icons PWAs need (Chrome install criteria, iOS home screen).
// Run after changing the SVG: `node scripts/gen-icons.mjs`. Output is committed.
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const svg = await readFile(new URL('../public/icon.svg', import.meta.url), 'utf8');
const targets = [
  { file: 'icon-192.png', size: 192, pad: 0 },
  { file: 'icon-512.png', size: 512, pad: 0 },
  { file: 'apple-touch-icon.png', size: 180, pad: 0 },
  // Maskable: content inside the 80 % safe zone on a full-bleed background.
  { file: 'icon-maskable-512.png', size: 512, pad: 0.1 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const { file, size, pad } of targets) {
  await page.setViewportSize({ width: size, height: size });
  const inset = Math.round(size * pad);
  await page.setContent(
    `<html><body style="margin:0;background:#0a0a0a">
       <div style="position:absolute;inset:${inset}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div>
     </body></html>`,
  );
  await page.screenshot({
    path: new URL(`../public/${file}`, import.meta.url).pathname,
    omitBackground: false,
  });
  console.log('wrote', file);
}
await browser.close();
