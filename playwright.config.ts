import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { wav } from './e2e/wav';

const PORT = 4173;

// The fake microphone records silence, so voice-over tests can measure the ducked music alone.
const FAKE_MIC = join(tmpdir(), 'video-editor-e2e', 'silence.wav');
mkdirSync(join(tmpdir(), 'video-editor-e2e'), { recursive: true });
writeFileSync(FAKE_MIC, wav({ rate: 48_000, seconds: 30 }));

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${FAKE_MIC}`,
      ],
    },
  },
  webServer: {
    command: `pnpm build && pnpm preview --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
  // Emulation only approximates viewport/touch; codec support still comes from the
  // host browser. Real-device testing remains mandatory (CLAUDE.md §7).
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'pixel-7', use: { ...devices['Pixel 7'] } },
    // iPhone profile runs on Chromium to avoid a WebKit download; it checks layout/touch only.
    {
      name: 'iphone-15',
      use: { ...devices['iPhone 15'], browserName: 'chromium', defaultBrowserType: 'chromium' },
    },
  ],
});
