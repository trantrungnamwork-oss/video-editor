/**
 * Export: decodes the timeline, re-encodes with the device's encoders and muxes the result.
 *
 * Resumable by design (ADR 0007):
 *  1. Audio is encoded in one pass into `audio.<ext>` (cheap; segmenting it would put encoder
 *     priming gaps at every seam).
 *  2. Video is encoded as independent segments `seg-N.<ext>` of SEGMENT_SEC each, every one
 *     starting with a keyframe. A checkpoint records finished work after each file.
 *  3. The segments and the audio are stream-copied (no re-encode) into the final file.
 * An interruption costs at most the segment in progress. All files live in an OPFS job directory.
 *
 * Memory stays bounded: frames go straight from decoder to encoder (Mediabunny applies
 * back-pressure on `add`) and every output streams to disk.
 */
import {
  AudioSampleSource,
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSampleSink,
  CanvasSource,
  WebMOutputFormat,
  type StreamTargetChunk,
} from 'mediabunny';
import { SUPPORTED_INPUT_FORMATS } from '../probe';
import { schedule, timelineTime, type ScheduledClip } from '../preview/sequence';
import { AUDIO_BITRATE, KEYFRAME_INTERVAL_SEC, type Format } from './plan';
import type { ClipLayout } from '../../core/frame';
import type { AudioItem, ClipAudio } from '../../core/project';
import { NO_MIX, type AudioMix } from '../audioMix';
import { encodeAudio } from './audioMixer';
import { drawFrame } from '../render/compositor';
import {
  identityOf,
  jobKey,
  overallFraction,
  planSegments,
  slicesInRange,
  type FileIdentity,
  type Phase,
  type Segment,
} from './segments';

export interface ExportClip {
  mediaId: string;
  file: File;
  inSec: number;
  outSec: number;
  hasAudio: boolean;
  audio?: ClipAudio | undefined;
  layout?: ClipLayout | undefined;
}

export interface ExportSettings {
  width: number;
  height: number;
  format: Format;
  videoBitrate: number;
  fileName: string;
}

export interface ExportJob extends ExportSettings {
  clips: ExportClip[];
  /** Music and voice-over mixed in (absent: none). */
  mix?: AudioMix | undefined;
}

/** A job's audio items as stored in a checkpoint (file identities, not files). */
export interface CheckpointMix {
  audioItems: (AudioItem & { file: FileIdentity })[];
  duck: boolean;
}

export const checkpointMix = (mix: AudioMix | undefined): CheckpointMix => ({
  audioItems: (mix ?? NO_MIX).audioItems.map((a) => ({ ...a, file: identityOf(a.file) })),
  duck: (mix ?? NO_MIX).duck,
});

export interface ExportProgress {
  fraction: number;
  phase: Phase;
}

export interface Checkpoint {
  key: string;
  settings: ExportSettings;
  clips: {
    mediaId: string;
    file: FileIdentity;
    inSec: number;
    outSec: number;
    hasAudio: boolean;
    audio?: ClipAudio | undefined;
    layout?: ClipLayout | undefined;
  }[];
  mix?: CheckpointMix;
  totalSec: number;
  audioDone: boolean;
  segmentsDone: number;
  segmentCount: number;
}

/** Storage for one export job (OPFS directory in the worker, fakes in tests). */
export interface JobStore {
  readCheckpoint(): Promise<Checkpoint | null>;
  writeCheckpoint(c: Checkpoint): Promise<void>;
  writer(name: string): Promise<{ stream: WritableStream<StreamTargetChunk>; close(): void }>;
  file(name: string): Promise<File>;
  clear(): Promise<void>;
}

export class ExportCancelled extends Error {
  override readonly name = 'ExportCancelled';
  constructor() {
    super('Export cancelled');
  }
}

/** A recoverable failure (e.g. codec reclaimed while in the background): resume later. */
export class ExportInterrupted extends Error {
  override readonly name = 'ExportInterrupted';
  constructor(
    readonly fraction: number,
    readonly causeMessage: string,
  ) {
    super(`Export interrupted: ${causeMessage}`);
  }
}

const ext = (f: Format) => f.container;
const segName = (s: Segment, f: Format) => `seg-${String(s.index).padStart(4, '0')}.${ext(f)}`;

export function checkpointFor(job: ExportJob): Checkpoint {
  const clips = job.clips.map((c) => ({
    mediaId: c.mediaId,
    file: identityOf(c.file),
    inSec: c.inSec,
    outSec: c.outSec,
    hasAudio: c.hasAudio,
    ...(c.audio ? { audio: c.audio } : {}),
    ...(c.layout ? { layout: c.layout } : {}),
  }));
  const totalSec = clips.reduce((t, c) => t + c.outSec - c.inSec, 0);
  const { width, height, format, videoBitrate, fileName } = job;
  const mix = checkpointMix(job.mix);
  return {
    key: jobKey({ ...job, clips, mix }),
    settings: { width, height, format, videoBitrate, fileName },
    clips,
    mix,
    totalSec,
    audioDone: false,
    segmentsDone: 0,
    segmentCount: planSegments(totalSec).length,
  };
}

export interface RunOptions {
  signal: AbortSignal;
  onProgress: (p: ExportProgress) => void;
  /** Test hook: throw inside this segment (once) to exercise the resume path. */
  injectFault?: (segmentIndex: number) => boolean;
}

export async function runExport(
  job: ExportJob,
  store: JobStore,
  target: WritableStream<StreamTargetChunk>,
  opts: RunOptions,
): Promise<void> {
  const seq = schedule(job.clips.map((c, i) => ({ ...c, id: String(i), frameRate: null })));
  const fresh = checkpointFor(job);
  if (fresh.totalSec <= 0) throw new Error('Nothing to export');

  let cp = await store.readCheckpoint().catch(() => null);
  if (!cp || cp.key !== fresh.key) {
    await store.clear();
    cp = fresh;
    await store.writeCheckpoint(cp);
  }
  const withAudio = seq.some((c) => c.hasAudio) || (job.mix?.audioItems.length ?? 0) > 0;
  const segments = planSegments(cp.totalSec);
  const progress = {
    audio: cp.audioDone || !withAudio ? 1 : 0,
    video: cp.segmentsDone / segments.length,
    mux: 0,
  };
  const report = (phase: Phase) => opts.onProgress({ fraction: overallFraction(progress), phase });
  const check = () => {
    if (opts.signal.aborted) throw new ExportCancelled();
  };
  const interrupted = (err: unknown): never => {
    if (opts.signal.aborted || err instanceof ExportCancelled) throw new ExportCancelled();
    throw new ExportInterrupted(
      overallFraction(progress),
      err instanceof Error ? err.message : String(err),
    );
  };

  // 1. Audio, one pass.
  if (withAudio && !cp.audioDone) {
    try {
      await encodeAudioFile(job, seq, store, check, (f) => {
        progress.audio = f;
        report('audio');
      });
    } catch (err) {
      interrupted(err);
    }
    cp = { ...cp, audioDone: true };
    await store.writeCheckpoint(cp);
  }

  // 2. Video segments.
  for (const seg of segments.slice(cp.segmentsDone)) {
    check();
    try {
      await encodeVideoSegment(job, seq, seg, store, check, opts.injectFault, (f) => {
        progress.video = (seg.index + f) / segments.length;
        report('video');
      });
    } catch (err) {
      interrupted(err);
    }
    cp = { ...cp, segmentsDone: seg.index + 1 };
    await store.writeCheckpoint(cp);
  }

  // 3. Stream-copy into the final file.
  check();
  await mux(job.format, segments, withAudio, store, target, check, (f) => {
    progress.mux = f;
    report('mux');
  });
  await store.clear();
}

function containerFormat(f: Format) {
  return f.container === 'mp4' ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat();
}

async function withOutput(
  store: JobStore,
  name: string,
  format: Format,
  setup: (o: Output) => void,
  body: () => Promise<void>,
) {
  const w = await store.writer(name);
  const output = new Output({
    format: containerFormat(format),
    target: new StreamTarget(w.stream, { chunked: true, chunkSize: 2 * 1024 * 1024 }),
  });
  setup(output);
  try {
    await output.start();
    await body();
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw err;
  } finally {
    w.close();
  }
}

function openClip(file: File): Input {
  return new Input({
    source: new BlobSource(file, { maxCacheSize: 8 * 1024 * 1024 }),
    formats: SUPPORTED_INPUT_FORMATS,
  });
}

async function encodeVideoSegment(
  job: ExportJob,
  seq: ScheduledClip[],
  seg: Segment,
  store: JobStore,
  check: () => void,
  injectFault: RunOptions['injectFault'],
  progress: (f: number) => void,
) {
  // Every frame is composed at output size (clip placement, later overlays), then encoded.
  const canvas = new OffscreenCanvas(job.width, job.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D context unavailable on OffscreenCanvas');
  const source = new CanvasSource(canvas, {
    codec: job.format.video,
    bitrate: job.videoBitrate,
    keyFrameInterval: KEYFRAME_INTERVAL_SEC,
    latencyMode: 'quality',
  });
  await withOutput(
    store,
    segName(seg, job.format),
    job.format,
    (o) => o.addVideoTrack(source),
    async () => {
      let frames = 0;
      for (const slice of slicesInRange(seq, seg.startSec, seg.endSec)) {
        const { clip } = slice;
        const input = openClip(clip.file);
        try {
          const track = await input.getPrimaryVideoTrack();
          if (!track) throw new Error(`${clip.file.name}: no video track`);
          const sink = new VideoSampleSink(track);
          for await (const sample of sink.samples(slice.sourceFrom, slice.sourceTo)) {
            try {
              check();
              const start = timelineTime(clip, sample.timestamp);
              // A frame that started in the previous segment was encoded there.
              if (start < seg.startSec - 1e-6) continue;
              const end = Math.min(
                clip.endSec,
                timelineTime(clip, sample.timestamp + sample.duration),
              );
              if (end - start <= 1e-6) continue;
              if (++frames === 5 && injectFault?.(seg.index)) throw new Error('Injected fault');
              drawFrame(ctx, sample, clip.layout);
              await source.add(start, end - start);
              progress((end - seg.startSec) / (seg.endSec - seg.startSec));
            } finally {
              sample.close();
            }
          }
        } finally {
          input.dispose();
        }
      }
    },
  );
}

async function encodeAudioFile(
  job: ExportJob,
  seq: ScheduledClip[],
  store: JobStore,
  check: () => void,
  progress: (f: number) => void,
) {
  const source = audioSource(job.format.audio);
  const total = seq[seq.length - 1]?.endSec ?? 0;
  await withOutput(
    store,
    `audio.${ext(job.format)}`,
    job.format,
    (o) => o.addAudioTrack(source),
    () =>
      encodeAudio(seq, job.mix ?? NO_MIX, source, check, (t) =>
        progress(total > 0 ? t / total : 1),
      ),
  );
}

/** Audio encoder source used by every export path (48 kHz stereo, resampled as needed). */
export function audioSource(codec: 'aac' | 'opus'): AudioSampleSource {
  return new AudioSampleSource({
    codec,
    bitrate: AUDIO_BITRATE,
    // No transform: encodeAudio already delivers 48 kHz stereo (see resample.ts); Mediabunny
    // rejects sources whose rate changes mid-stream.
  });
}

export { encodeAudio };

async function mux(
  format: Format,
  segments: Segment[],
  withAudio: boolean,
  store: JobStore,
  target: WritableStream<StreamTargetChunk>,
  check: () => void,
  progress: (f: number) => void,
) {
  const output = new Output({
    format: containerFormat(format),
    target: new StreamTarget(target, { chunked: true, chunkSize: 2 * 1024 * 1024 }),
  });
  const video = new EncodedVideoPacketSource(format.video);
  output.addVideoTrack(video);
  const audio = withAudio ? new EncodedAudioPacketSource(format.audio) : null;
  if (audio) output.addAudioTrack(audio);

  const copyVideo = async () => {
    let baseConfig: VideoDecoderConfig | null = null;
    for (const seg of segments) {
      check();
      const input = openClip(await store.file(segName(seg, format)));
      try {
        // A range with no frame (audio outlasting the video) yields a segment without a video
        // track; there is nothing to copy. Frames are never dropped, so this loses no video.
        const track = await input.getPrimaryVideoTrack();
        if (!track) continue;
        const config = await track.getDecoderConfig();
        if (!config) throw new Error(`segment ${seg.index}: unknown codec`);
        if (baseConfig && !sameDecoderConfig(baseConfig, config)) {
          throw new Error('The encoder changed its output settings between segments');
        }
        let first = !baseConfig;
        baseConfig ??= config;
        for await (const packet of new EncodedPacketSink(track).packets()) {
          await video.add(packet, first ? { decoderConfig: config } : undefined);
          first = false;
        }
      } finally {
        input.dispose();
      }
      progress((seg.index + 1) / segments.length);
    }
    if (!baseConfig) throw new Error('The export produced no video frames');
  };

  const copyAudio = async () => {
    if (!audio) return;
    const input = openClip(await store.file(`audio.${ext(format)}`));
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) throw new Error('audio file has no audio');
      const config = await track.getDecoderConfig();
      let first = true;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        await audio.add(packet, first && config ? { decoderConfig: config } : undefined);
        first = false;
      }
    } finally {
      input.dispose();
    }
  };

  try {
    await output.start();
    await Promise.all([copyVideo(), copyAudio()]);
    check();
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw err;
  }
}

function sameDecoderConfig(a: VideoDecoderConfig, b: VideoDecoderConfig): boolean {
  if (a.codec !== b.codec || a.codedWidth !== b.codedWidth || a.codedHeight !== b.codedHeight) {
    return false;
  }
  return bytesEqual(a.description, b.description);
}

function bytesEqual(
  a: AllowSharedBufferSource | undefined,
  b: AllowSharedBufferSource | undefined,
) {
  if (!a || !b) return !a && !b;
  const x =
    a instanceof ArrayBuffer || a instanceof SharedArrayBuffer
      ? new Uint8Array(a)
      : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y =
    b instanceof ArrayBuffer || b instanceof SharedArrayBuffer
      ? new Uint8Array(b)
      : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
