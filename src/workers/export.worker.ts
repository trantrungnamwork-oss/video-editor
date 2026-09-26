import { canEncodeAudio, canEncodeVideo } from 'mediabunny';
import { ExportCancelled, runExport } from '../media/export/exportPipeline';
import { clearExports, openOpfsWriter } from '../media/export/opfsFile';
import {
  AUDIO_BITRATE,
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
  planPresets,
} from '../media/export/plan';
import type { FromExportWorker, ToExportWorker } from '../media/export/protocol';

const PROGRESS_INTERVAL_MS = 200;
let abort: AbortController | null = null;

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
      void start(msg.job, msg.fileName);
      return;
    case 'cancel':
      abort?.abort();
      return;
  }
};

async function start(job: Parameters<typeof runExport>[0], fileName: string) {
  abort?.abort();
  const controller = new AbortController();
  abort = controller;
  let writer: Awaited<ReturnType<typeof openOpfsWriter>> | null = null;
  try {
    await clearExports();
    writer = await openOpfsWriter(fileName);
    let lastPost = 0;
    await runExport(job, writer.stream, controller.signal, (progress) => {
      const now = performance.now();
      if (now - lastPost < PROGRESS_INTERVAL_MS) return;
      lastPost = now;
      post({ type: 'progress', progress, bytesWritten: writer?.bytesWritten ?? 0 });
    });
    const file = await writer.file();
    post({
      type: 'done',
      file: new File([file], fileName, { type: file.type || mimeOf(fileName) }),
    });
  } catch (err) {
    await writer?.remove();
    if (err instanceof ExportCancelled) post({ type: 'cancelled' });
    else post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    if (abort === controller) abort = null;
  }
}

const mimeOf = (name: string) => (name.endsWith('.mp4') ? 'video/mp4' : 'video/webm');
