/**
 * Export benchmark (CLAUDE.md §9): time to export a 1080p clip and peak memory, per device.
 * Used by the /bench page on real devices and by `pnpm bench` (Playwright) on a dev machine.
 */
import { ExportClient, type ExportEvent } from './export/exportClient';
import type { CopyClip } from './export/copyExport';
import { exportFileName, type PresetPlan } from './export/plan';
import type { MediaInfo } from './probe';
import { startPeakMemory, type MemoryMethod } from './memory';

export interface BenchResult {
  mode: 'reencode' | 'original';
  /** e.g. "MP4 H.264+AAC 1920×1080" */
  format: string;
  sourceSec: number;
  exportSec: number;
  /** Source seconds per wall-clock second (>1 = faster than real time). */
  speed: number;
  outputBytes: number;
  peakMemoryBytes: number | null;
  memoryMethod: MemoryMethod;
}

export interface BenchRun {
  version: string;
  date: string;
  /** Informational only (never used for feature decisions). */
  userAgent: string;
  hardwareConcurrency: number | null;
  deviceMemoryGB: number | null;
  source: { name: string; width: number; height: number; fps: number | null; video: string | null };
  results: BenchResult[];
}

function runOnce(
  start: (listener: (e: ExportEvent) => void) => void,
  onProgress: (f: number) => void,
): Promise<{ file: File; seconds: number; peak: number | null; method: MemoryMethod }> {
  const mem = startPeakMemory();
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    start((e) => {
      if (e.type === 'progress') onProgress(e.progress.fraction);
      else if (e.type === 'done') {
        const seconds = (performance.now() - t0) / 1000;
        void mem
          .stop()
          .then((peak) => resolve({ file: e.file, seconds, peak, method: mem.method }));
      } else if (e.type === 'interrupted' || e.type === 'error') {
        void mem.stop();
        reject(new Error(e.message));
      } else if (e.type === 'cancelled') {
        void mem.stop();
        reject(new Error('cancelled'));
      }
    });
  });
}

export async function runBenchmark(
  file: File,
  info: MediaInfo,
  version: string,
  onStatus: (s: string) => void,
): Promise<BenchRun> {
  const client = new ExportClient();
  try {
    const clip: CopyClip = {
      clipId: 'bench',
      mediaId: 'bench',
      file,
      inSec: 0,
      outSec: info.durationSec,
      hasAudio: info.audio?.decode.status === 'supported',
    };
    const results: BenchResult[] = [];
    if (!info.video) throw new Error(`${file.name} has no video`);
    const video = info.video;
    const { displayWidth: w, displayHeight: h, frameRate } = video;

    // Re-encode at 1080p (or the best preset this device can encode).
    const plans = await client.plan(w, h, frameRate ?? 30);
    const plan: PresetPlan | undefined =
      plans.find((p) => p.preset === '1080p' && p.format && !p.upscale) ??
      [...plans].reverse().find((p) => p.format);
    if (plan?.format) {
      const format = plan.format;
      onStatus(`Re-encoding ${plan.width}×${plan.height}…`);
      const r = await runOnce(
        (l) =>
          client.start(
            {
              clips: [clip],
              width: plan.width,
              height: plan.height,
              format,
              videoBitrate: plan.videoBitrate,
              fileName: exportFileName(format.container),
            },
            l,
          ),
        (f) => onStatus(`Re-encoding ${plan.width}×${plan.height}… ${Math.round(f * 100)}%`),
      );
      results.push({
        mode: 'reencode',
        format: `${format.container.toUpperCase()} ${format.video.toUpperCase()}+${format.audio.toUpperCase()} ${plan.width}×${plan.height}`,
        sourceSec: info.durationSec,
        exportSec: r.seconds,
        speed: info.durationSec / r.seconds,
        outputBytes: r.file.size,
        peakMemoryBytes: r.peak,
        memoryMethod: r.method,
      });
    }

    // Lossless copy, when the source allows it.
    const analysis = await client.analyzeCopy([clip]);
    if (analysis.eligible) {
      onStatus('Lossless copy…');
      const r = await runOnce(
        (l) =>
          client.startCopy(
            {
              clips: [clip],
              container: analysis.container,
              videoCodec: analysis.videoCodec,
              rotation: analysis.rotation,
              fileName: exportFileName(analysis.container),
            },
            l,
          ),
        (f) => onStatus(`Lossless copy… ${Math.round(f * 100)}%`),
      );
      results.push({
        mode: 'original',
        format: `${analysis.container.toUpperCase()} ${analysis.videoCodec.toUpperCase()} copy ${analysis.width}×${analysis.height}`,
        sourceSec: info.durationSec,
        exportSec: r.seconds,
        speed: info.durationSec / r.seconds,
        outputBytes: r.file.size,
        peakMemoryBytes: r.peak,
        memoryMethod: r.method,
      });
    }

    const nav = navigator as Navigator & { deviceMemory?: number };
    return {
      version,
      date: new Date().toISOString(),
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemoryGB: nav.deviceMemory ?? null,
      source: { name: file.name, width: w, height: h, fps: frameRate, video: video.codec },
      results,
    };
  } finally {
    client.dispose();
  }
}

const mb = (b: number | null) => (b === null ? 'n/a' : `${Math.round(b / 1e6)} MB`);

/** Markdown table rows for docs/benchmarks.md. */
export function benchMarkdownRows(run: BenchRun, device: string): string[] {
  return run.results.map((r) =>
    [
      run.version,
      run.date.slice(0, 10),
      device,
      r.mode === 'original' ? 'Original (copy)' : 'Re-encode',
      r.format,
      `${r.sourceSec.toFixed(1)} s`,
      `${r.exportSec.toFixed(1)} s`,
      `${r.speed.toFixed(2)}×`,
      `${mb(r.outputBytes)}`,
      r.memoryMethod === 'unavailable'
        ? 'n/a (no API)'
        : `${mb(r.peakMemoryBytes)} (${r.memoryMethod === 'performance.memory' ? 'JS heap' : 'page+workers'})`,
    ]
      .join(' | ')
      .replace(/^/, '| ')
      .replace(/$/, ' |'),
  );
}
