import { readFile } from 'node:fs/promises';
import { expect, type Browser } from '@playwright/test';
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';
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

/**
 * Peak level of the test clip's beep (first BEEP window of every second) in the exported file's
 * audio, per whole second. Demuxed here in Node, decoded with WebCodecs in the page.
 */
export async function beepPeaks(browser: Browser, path: string): Promise<number[]> {
  const bytes = await readFile(path);
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error(`${path}: no audio track`);
  const config = await track.getDecoderConfig();
  if (!config) throw new Error(`${path}: unknown audio codec`);
  const packets: { data: number[]; timestamp: number; duration: number }[] = [];
  for await (const p of new EncodedPacketSink(track).packets()) {
    packets.push({ data: Array.from(p.data), timestamp: p.timestamp, duration: p.duration });
  }
  const d = config.description;
  const description = d
    ? Array.from(
        ArrayBuffer.isView(d)
          ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
          : new Uint8Array(d),
      )
    : null;

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/'); // a secure context for WebCodecs
  const peaks = await page.evaluate(
    async ({ codec, sampleRate, numberOfChannels, description, packets }) => {
      const out: number[] = [];
      const decoder = new AudioDecoder({
        output: (data) => {
          const plane = new Float32Array(data.numberOfFrames);
          data.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
          const t0 = data.timestamp / 1e6;
          for (let i = 0; i < plane.length; i++) {
            const t = t0 + i / data.sampleRate;
            if (t < 0 || t % 1 >= 0.1) continue;
            const s = Math.floor(t);
            out[s] = Math.max(out[s] ?? 0, Math.abs(plane[i] ?? 0));
          }
          data.close();
        },
        error: (e) => {
          throw e;
        },
      });
      decoder.configure({
        codec,
        sampleRate,
        numberOfChannels,
        ...(description ? { description: new Uint8Array(description) } : {}),
      });
      for (const p of packets) {
        decoder.decode(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: Math.round(p.timestamp * 1e6),
            duration: Math.round(p.duration * 1e6),
            data: new Uint8Array(p.data),
          }),
        );
      }
      await decoder.flush();
      decoder.close();
      return Array.from(out, (v) => v ?? 0);
    },
    {
      codec: config.codec,
      sampleRate: config.sampleRate,
      numberOfChannels: config.numberOfChannels,
      description,
      packets,
    },
  );
  input.dispose();
  await ctx.close();
  return peaks;
}
