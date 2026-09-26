/**
 * Export: decodes every clip of the sequence, retimes frames and audio to the timeline, re-encodes
 * with the device's encoders and muxes into a streamed target (an OPFS file in the worker).
 *
 * Memory stays bounded: frames go straight from decoder to encoder (Mediabunny applies
 * back-pressure on `add`), audio is small, and the muxer writes out as it goes. Video and audio are
 * produced by two concurrent loops so the muxer never has to hold one track while waiting for the
 * other.
 */
import {
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSampleSink,
  VideoSampleSource,
  WebMOutputFormat,
  type StreamTargetChunk,
} from 'mediabunny';
import { SUPPORTED_INPUT_FORMATS } from '../probe';
import { audioWindow, schedule, timelineTime, type ScheduledClip } from '../preview/sequence';
import {
  AUDIO_BITRATE,
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
  KEYFRAME_INTERVAL_SEC,
  type Format,
} from './plan';

export interface ExportClip {
  mediaId: string;
  file: File;
  inSec: number;
  outSec: number;
  hasAudio: boolean;
}

export interface ExportJob {
  clips: ExportClip[];
  width: number;
  height: number;
  format: Format;
  videoBitrate: number;
}

export interface ExportProgress {
  /** Timeline seconds encoded so far (video). */
  encodedSec: number;
  totalSec: number;
}

const SILENCE_CHUNK_FRAMES = 4096;

export class ExportCancelled extends Error {
  override readonly name = 'ExportCancelled';
  constructor() {
    super('Export cancelled');
  }
}

export async function runExport(
  job: ExportJob,
  target: WritableStream<StreamTargetChunk>,
  signal: AbortSignal,
  onProgress: (p: ExportProgress) => void,
): Promise<void> {
  const seq = schedule(job.clips.map((c, i) => ({ ...c, id: String(i), frameRate: null })));
  const totalSec = seq[seq.length - 1]?.endSec ?? 0;
  if (totalSec <= 0) throw new Error('Nothing to export');

  const output = new Output({
    format:
      job.format.container === 'mp4'
        ? new Mp4OutputFormat({ fastStart: false })
        : new WebMOutputFormat(),
    target: new StreamTarget(target, { chunked: true, chunkSize: 2 * 1024 * 1024 }),
  });

  const video = new VideoSampleSource({
    codec: job.format.video,
    bitrate: job.videoBitrate,
    keyFrameInterval: KEYFRAME_INTERVAL_SEC,
    latencyMode: 'quality',
    // Every clip is scaled into the output frame; other aspect ratios are letterboxed.
    transform: { width: job.width, height: job.height, fit: 'contain' },
  });
  output.addVideoTrack(video);

  const withAudio = seq.some((c) => c.hasAudio);
  const audio = withAudio
    ? new AudioSampleSource({
        codec: job.format.audio,
        bitrate: AUDIO_BITRATE,
        transform: { sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: AUDIO_CHANNELS },
      })
    : null;
  if (audio) output.addAudioTrack(audio);

  const check = () => {
    if (signal.aborted) throw new ExportCancelled();
  };

  try {
    await output.start();
    await Promise.all([
      encodeVideo(seq, video, check, (t) => onProgress({ encodedSec: t, totalSec })),
      audio ? encodeAudio(seq, audio, check) : Promise.resolve(),
    ]);
    check();
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw signal.aborted ? new ExportCancelled() : err;
  }
}

async function openClip(clip: ScheduledClip): Promise<Input> {
  return new Input({
    source: new BlobSource(clip.file, { maxCacheSize: 8 * 1024 * 1024 }),
    formats: SUPPORTED_INPUT_FORMATS,
  });
}

async function encodeVideo(
  seq: ScheduledClip[],
  source: VideoSampleSource,
  check: () => void,
  progress: (t: number) => void,
) {
  for (const clip of seq) {
    check();
    const input = await openClip(clip);
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error(`${clip.file.name}: no video track`);
      for await (const sample of new VideoSampleSink(track).samples(clip.inSec, clip.outSec)) {
        try {
          check();
          const start = timelineTime(clip, sample.timestamp);
          const end = Math.min(clip.endSec, timelineTime(clip, sample.timestamp + sample.duration));
          if (end - start <= 1e-6) continue;
          sample.setTimestamp(start);
          sample.setDuration(end - start);
          await source.add(sample);
          progress(end);
        } finally {
          sample.close();
        }
      }
    } finally {
      input.dispose();
    }
  }
}

async function encodeAudio(seq: ScheduledClip[], source: AudioSampleSource, check: () => void) {
  /** Timeline time up to which audio has been written; gaps are filled with silence. */
  let written = 0;
  const silenceUntil = async (t: number) => {
    while (t - written > 1e-4) {
      check();
      const frames = Math.min(SILENCE_CHUNK_FRAMES, Math.round((t - written) * AUDIO_SAMPLE_RATE));
      if (frames <= 0) break;
      const s = new AudioSample({
        data: new Float32Array(frames * AUDIO_CHANNELS),
        format: 'f32-planar',
        numberOfChannels: AUDIO_CHANNELS,
        sampleRate: AUDIO_SAMPLE_RATE,
        timestamp: written,
      });
      try {
        await source.add(s);
      } finally {
        s.close();
      }
      written += frames / AUDIO_SAMPLE_RATE;
    }
  };

  for (const clip of seq) {
    check();
    if (clip.hasAudio) {
      const input = await openClip(clip);
      try {
        const track = await input.getPrimaryAudioTrack();
        if (track) {
          for await (const sample of new AudioSampleSink(track).samples(clip.inSec, clip.outSec)) {
            try {
              check();
              const win = audioWindow(
                sample.timestamp,
                sample.numberOfFrames,
                sample.sampleRate,
                clip.inSec,
                clip.outSec,
              );
              if (!win) continue;
              const ts = timelineTime(clip, sample.timestamp + win.offset / sample.sampleRate);
              await silenceUntil(ts); // tiny gaps between audio packets or a late first packet
              const whole = win.offset === 0 && win.count === sample.numberOfFrames;
              const part = whole ? sample : sample.trim(win.offset, win.offset + win.count);
              try {
                part.setTimestamp(Math.max(ts, written));
                await source.add(part);
                written = Math.max(written, ts + win.count / sample.sampleRate);
              } finally {
                if (part !== sample) part.close();
              }
            } finally {
              sample.close();
            }
          }
        }
      } finally {
        input.dispose();
      }
    }
    // Clips without audio (or whose audio ends early) become silence.
    await silenceUntil(clip.endSec);
  }
}
