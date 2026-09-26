import { canEncodeAudio, canEncodeVideo } from 'mediabunny';
import { analyzeCopy, runCopyExport, type CopyJob } from '../media/export/copyExport';
import {
  audioSource,
  encodeAudio,
  ExportCancelled,
  ExportInterrupted,
  runExport,
  type ExportJob,
} from '../media/export/exportPipeline';
import {
  clearFinishedExports,
  exportDir,
  openJobStore,
  openOpfsWriter,
} from '../media/export/opfsFile';
import {
  AUDIO_BITRATE,
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
  planPresets,
} from '../media/export/plan';
import type { FromExportWorker, ToExportWorker } from '../media/export/protocol';

const PROGRESS_INTERVAL_MS = 200;
let abort: AbortController | null = null;
/** Faults already injected (test hook), so a resumed attempt succeeds. */
const injected = new Set<number>();

const post = (msg: FromExportWorker) => postMessage(msg);

self.onmessage = (e: MessageEvent<ToExportWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'plan':
      void planPresets(
        msg.sourceWidth,
        msg.sourceHeight,
        msg.fps,
        async (f, width, height, bitrate) => {
          const [v, a] = await Promise.all([
            canEncodeVideo(f.video, { width, height, bitrate, frameRate: msg.fps }),
            canEncodeAudio(f.audio, {
              sampleRate: AUDIO_SAMPLE_RATE,
              numberOfChannels: AUDIO_CHANNELS,
              bitrate: AUDIO_BITRATE,
            }),
          ]);
          return v && a;
        },
      ).then(
        (plans) => post({ type: 'plan', id: msg.id, plans }),
        (err: unknown) => post({ type: 'error', message: String(err) }),
      );
      return;
    case 'start':
      void start(msg.job, msg.resume, msg.faultAtSegment);
      return;
    case 'analyze-copy':
      void analyzeCopy(msg.clips, audioEncodable).then(
        (analysis) => post({ type: 'analysis', id: msg.id, analysis }),
        (err: unknown) =>
          post({
            type: 'analysis',
            id: msg.id,
            analysis: { eligible: false, reason: String(err), snaps: [] },
          }),
      );
      return;
    case 'start-copy':
      void startCopy(msg.job);
      return;
    case 'cancel':
      abort?.abort();
      return;
  }
};

async function start(job: ExportJob, resume: boolean, faultAtSegment: number | undefined) {
  abort?.abort();
  const controller = new AbortController();
  abort = controller;
  const store = await openJobStore();
  let writer: Awaited<ReturnType<typeof openOpfsWriter>> | null = null;
  try {
    await clearFinishedExports();
    if (!resume) await store.clear();
    writer = await openOpfsWriter(await exportDir(), job.fileName);
    let lastPost = 0;
    await runExport(job, store, writer.stream, {
      signal: controller.signal,
      onProgress: (progress) => {
        const now = performance.now();
        if (now - lastPost < PROGRESS_INTERVAL_MS) return;
        lastPost = now;
        post({ type: 'progress', progress, bytesWritten: writer?.bytesWritten ?? 0 });
      },
      injectFault: (segment) => {
        if (segment !== faultAtSegment || injected.has(segment)) return false;
        injected.add(segment);
        return true;
      },
    });
    const file = await writer.file();
    post({ type: 'done', file: new File([file], job.fileName, { type: mimeOf(job.fileName) }) });
  } catch (err) {
    await writer?.remove();
    if (err instanceof ExportInterrupted) {
      post({ type: 'interrupted', fraction: err.fraction, message: err.causeMessage });
    } else if (err instanceof ExportCancelled) {
      await store.clear();
      post({ type: 'cancelled' });
    } else {
      await store.clear();
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    if (abort === controller) abort = null;
  }
}

const audioEncodable = (codec: 'aac' | 'opus') =>
  canEncodeAudio(codec, {
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: AUDIO_BITRATE,
  });

async function startCopy(job: CopyJob) {
  abort?.abort();
  const controller = new AbortController();
  abort = controller;
  let writer: Awaited<ReturnType<typeof openOpfsWriter>> | null = null;
  try {
    await clearFinishedExports();
    writer = await openOpfsWriter(await exportDir(), job.fileName);
    const withAudio = job.clips.some((c) => c.hasAudio);
    const audio = withAudio ? audioSource(job.container === 'mp4' ? 'aac' : 'opus') : null;
    const check = () => {
      if (controller.signal.aborted) throw new ExportCancelled();
    };
    let lastPost = 0;
    await runCopyExport(job, writer.stream, {
      signal: controller.signal,
      onProgress: (fraction) => {
        const now = performance.now();
        if (now - lastPost < PROGRESS_INTERVAL_MS) return;
        lastPost = now;
        post({
          type: 'progress',
          progress: { fraction, phase: 'video' },
          bytesWritten: writer?.bytesWritten ?? 0,
        });
      },
      ...(audio
        ? {
            audio: {
              source: audio,
              encode: (seq) => encodeAudio(seq, audio, check, () => undefined),
            },
          }
        : {}),
    });
    const file = await writer.file();
    post({ type: 'done', file: new File([file], job.fileName, { type: mimeOf(job.fileName) }) });
  } catch (err) {
    await writer?.remove();
    if (controller.signal.aborted) post({ type: 'cancelled' });
    // Nothing to resume: a copy is fast, so an interruption simply restarts it.
    else
      post({
        type: 'interrupted',
        fraction: 0,
        message: err instanceof Error ? err.message : String(err),
      });
  } finally {
    if (abort === controller) abort = null;
  }
}

const mimeOf = (name: string) => (name.endsWith('.mp4') ? 'video/mp4' : 'video/webm');
