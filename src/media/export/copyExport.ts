/**
 * Smart cut, lossless path (ADR 0008): when every clip comes from compatible streams and every cut
 * lands on a keyframe, the compressed video packets are copied into the output unchanged, with no
 * decode and no re-encode. Only the audio is re-encoded (cheap, and it avoids AAC/Opus priming
 * glitches at the joins).
 *
 * Runs in the export worker. Demux-only, so it is unit-tested in Node with synthetic media.
 */
import {
  BlobSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type InputVideoTrack,
  type Rotation,
  type StreamTargetChunk,
  type AudioSampleSource,
} from 'mediabunny';
import { MIN_CLIP_SEC } from '../../core/project';
import { SUPPORTED_INPUT_FORMATS } from '../probe';
import { schedule, type ScheduledClip } from '../preview/sequence';
import type { Container } from './plan';

export interface CopyClip {
  clipId: string;
  mediaId: string;
  file: File;
  inSec: number;
  outSec: number;
  hasAudio: boolean;
}

/** Moves a clip's cut points onto keyframes so the timeline becomes copyable. */
export interface CutSnap {
  clipId: string;
  inSec?: number;
  outSec?: number;
  /** Largest distance a cut moves, in seconds. */
  shiftSec: number;
}

export type CopyAnalysis =
  | {
      eligible: true;
      container: Container;
      videoCodec: string;
      audioCodec: 'aac' | 'opus' | null;
      width: number;
      height: number;
      rotation: Rotation;
    }
  | {
      eligible: false;
      reason: string;
      /** Non-empty when snapping these cuts to keyframes would make the timeline copyable. */
      snaps: CutSnap[];
    };

const CONTAINER_FOR: Record<string, Container> = {
  avc: 'mp4',
  hevc: 'mp4',
  av1: 'mp4',
  vp9: 'webm',
  vp8: 'webm',
};
const AUDIO_FOR: Record<Container, 'aac' | 'opus'> = { mp4: 'aac', webm: 'opus' };

interface OpenedClip {
  clip: CopyClip;
  input: Input;
  track: InputVideoTrack;
  sink: EncodedPacketSink;
  config: VideoDecoderConfig;
  mediaEnd: number;
  halfFrame: number;
}

async function openClip(clip: CopyClip): Promise<OpenedClip | string> {
  const input = new Input({
    source: new BlobSource(clip.file, { maxCacheSize: 4 * 1024 * 1024 }),
    formats: SUPPORTED_INPUT_FORMATS,
  });
  const track = await input.getPrimaryVideoTrack();
  const config = await track?.getDecoderConfig();
  if (!track || !config) {
    input.dispose();
    return `${clip.file.name}: unknown video codec`;
  }
  const [mediaEnd, fps] = await Promise.all([
    input.computeDuration([track]),
    track.computeFrameRateMetrics({ targetPacketCount: 64 }).then(
      (m) => m.bestGuessFrameRate,
      () => 30,
    ),
  ]);
  return {
    clip,
    input,
    track,
    sink: new EncodedPacketSink(track),
    config,
    mediaEnd,
    halfFrame: 0.5 / (fps > 0 ? fps : 30),
  };
}

/** Does playback of this stream reorder frames (B-frames)? Checked on its first GOPs. */
async function hasReordering(sink: EncodedPacketSink): Promise<boolean> {
  let last = -Infinity;
  let n = 0;
  for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
    if (p.timestamp < last) return true;
    last = p.timestamp;
    if (++n >= 120) break;
  }
  return false;
}

/** The frame shown at `t` is a keyframe (i.e. decoding can start exactly there). */
async function keyAt(o: OpenedClip, t: number): Promise<boolean> {
  const p = await o.sink.getPacket(t, { metadataOnly: true });
  return !!p && p.type === 'key' && Math.abs(p.timestamp - t) <= o.halfFrame;
}

/** Keyframe timestamps just before/at and after `t`. */
async function keysAround(o: OpenedClip, t: number): Promise<number[]> {
  const prev = await o.sink.getKeyPacket(t, { metadataOnly: true });
  if (!prev) return [];
  const next = await o.sink.getNextKeyPacket(prev, { metadataOnly: true });
  return next ? [prev.timestamp, next.timestamp] : [prev.timestamp];
}

/** Closest candidate to `t` within [lo, hi]; ties go to the earlier one. */
export function nearest(t: number, candidates: number[], lo: number, hi: number): number | null {
  let best: number | null = null;
  for (const c of candidates) {
    if (c < lo - 1e-9 || c > hi + 1e-9) continue;
    if (best === null || Math.abs(c - t) < Math.abs(best - t) - 1e-9) best = c;
  }
  return best;
}

export function sameConfig(a: VideoDecoderConfig, b: VideoDecoderConfig): boolean {
  if (a.codec !== b.codec || a.codedWidth !== b.codedWidth || a.codedHeight !== b.codedHeight) {
    return false;
  }
  const bytes = (d: AllowSharedBufferSource | undefined) =>
    !d
      ? null
      : d instanceof ArrayBuffer ||
          (typeof SharedArrayBuffer !== 'undefined' && d instanceof SharedArrayBuffer)
        ? new Uint8Array(d)
        : new Uint8Array(
            (d as ArrayBufferView).buffer,
            (d as ArrayBufferView).byteOffset,
            (d as ArrayBufferView).byteLength,
          );
  const x = bytes(a.description);
  const y = bytes(b.description);
  if (!x || !y) return !x && !y;
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export async function analyzeCopy(
  clips: CopyClip[],
  audioEncodable: (codec: 'aac' | 'opus') => Promise<boolean>,
): Promise<CopyAnalysis> {
  if (clips.length === 0) return { eligible: false, reason: 'Nothing to export', snaps: [] };
  const opened: OpenedClip[] = [];
  try {
    for (const c of clips) {
      const o = await openClip(c);
      if (typeof o === 'string') return { eligible: false, reason: o, snaps: [] };
      opened.push(o);
    }
    const [first] = opened;
    if (!first) return { eligible: false, reason: 'Nothing to export', snaps: [] };

    const codec = await first.track.getCodec();
    const container = codec ? CONTAINER_FOR[codec] : undefined;
    if (!codec || !container) {
      return {
        eligible: false,
        reason: `${codec ?? 'This'} video can't be copied losslessly`,
        snaps: [],
      };
    }
    const rotation = await first.track.getRotation();
    for (const o of opened) {
      if (!sameConfig(first.config, o.config) || (await o.track.getRotation()) !== rotation) {
        return {
          eligible: false,
          reason: 'Clips were recorded with different settings, so they must be re-encoded',
          snaps: [],
        };
      }
    }

    const withAudio = clips.some((c) => c.hasAudio);
    const audioCodec = withAudio ? AUDIO_FOR[container] : null;
    if (audioCodec && !(await audioEncodable(audioCodec))) {
      return {
        eligible: false,
        reason: `This device can't encode ${audioCodec.toUpperCase()} audio for the ${container.toUpperCase()} file`,
        snaps: [],
      };
    }

    // Cut points: every in point must start on a keyframe; every out point must end right before
    // one (or at the end of the media, or anywhere when frames are never reordered).
    const snaps: CutSnap[] = [];
    let offKey = 0;
    const reorder = new Map<OpenedClip, boolean>();
    for (const o of opened) {
      const { clip } = o;
      const snap: CutSnap = { clipId: clip.clipId, shiftSec: 0 };
      let inSec = clip.inSec;
      if (!(await keyAt(o, clip.inSec))) {
        offKey++;
        const to = nearest(
          clip.inSec,
          await keysAround(o, clip.inSec),
          0,
          clip.outSec - MIN_CLIP_SEC,
        );
        if (to === null)
          return {
            eligible: false,
            reason: 'A clip is shorter than one keyframe interval',
            snaps: [],
          };
        snap.inSec = to;
        snap.shiftSec = Math.abs(to - clip.inSec);
        inSec = to;
      }
      const atEnd = clip.outSec >= o.mediaEnd - o.halfFrame;
      if (!atEnd && !(await keyAt(o, clip.outSec))) {
        if (!reorder.has(o)) reorder.set(o, await hasReordering(o.sink));
        if (reorder.get(o)) {
          offKey++;
          const candidates = [...(await keysAround(o, clip.outSec)), o.mediaEnd];
          const to = nearest(clip.outSec, candidates, inSec + MIN_CLIP_SEC, o.mediaEnd);
          if (to === null)
            return {
              eligible: false,
              reason: 'A clip is shorter than one keyframe interval',
              snaps: [],
            };
          snap.outSec = to;
          snap.shiftSec = Math.max(snap.shiftSec, Math.abs(to - clip.outSec));
        }
      }
      if (snap.inSec !== undefined || snap.outSec !== undefined) snaps.push(snap);
    }
    if (offKey > 0) {
      return {
        eligible: false,
        reason: `${offKey} cut${offKey > 1 ? 's are' : ' is'} not on a keyframe`,
        snaps,
      };
    }

    return {
      eligible: true,
      container,
      videoCodec: codec,
      audioCodec,
      width: first.config.codedWidth ?? 0,
      height: first.config.codedHeight ?? 0,
      rotation,
    };
  } finally {
    for (const o of opened) o.input.dispose();
  }
}

export interface CopyJob {
  clips: CopyClip[];
  container: Container;
  videoCodec: string;
  rotation: Rotation;
  fileName: string;
}

/**
 * Copies the video packets of every clip, retimed to the timeline, into one file. `addAudio`
 * attaches and feeds a re-encoded audio track (omitted in tests / silent timelines).
 */
export async function runCopyExport(
  job: CopyJob,
  target: WritableStream<StreamTargetChunk>,
  opts: {
    signal: AbortSignal;
    onProgress: (fraction: number) => void;
    audio?: { source: AudioSampleSource; encode: (seq: ScheduledClip[]) => Promise<void> };
  },
): Promise<void> {
  const seq = schedule(job.clips.map((c) => ({ ...c, id: c.clipId, frameRate: null })));
  const total = seq[seq.length - 1]?.endSec ?? 0;
  const output = new Output({
    format:
      job.container === 'mp4' ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
    target: new StreamTarget(target, { chunked: true, chunkSize: 2 * 1024 * 1024 }),
  });
  const video = new EncodedVideoPacketSource(
    job.videoCodec as ConstructorParameters<typeof EncodedVideoPacketSource>[0],
  );
  output.addVideoTrack(video, { rotation: job.rotation });
  if (opts.audio) output.addAudioTrack(opts.audio.source);

  const check = () => {
    if (opts.signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
  };

  const copyVideo = async () => {
    let first = true;
    for (const clip of seq) {
      check();
      const o = await openClip({ ...clip, clipId: clip.id });
      if (typeof o === 'string') throw new Error(o);
      try {
        const start = await o.sink.getKeyPacket(clip.inSec);
        if (!start) throw new Error(`${clip.file.name}: no keyframe at the cut`);
        for await (const p of o.sink.packets(start)) {
          check();
          if (p.timestamp >= clip.outSec - 1e-6) {
            // The next GOP starts here: the clip is complete. Non-key frames past the out point
            // only exist in reorder-free streams, where they can simply be skipped.
            if (p.type === 'key') break;
            continue;
          }
          // Leading pictures that reference the previous GOP can't be decoded from here.
          if (p.timestamp < start.timestamp - 1e-6) continue;
          const ts = clip.startSec + (p.timestamp - start.timestamp);
          const duration = Math.max(0, Math.min(p.duration, clip.endSec - ts));
          await video.add(
            new EncodedPacket(p.data, p.type, ts, duration),
            first ? { decoderConfig: o.config } : undefined,
          );
          first = false;
          if (total > 0) opts.onProgress(Math.min(1, (ts + duration) / total));
        }
      } finally {
        o.input.dispose();
      }
    }
  };

  try {
    await output.start();
    await Promise.all([copyVideo(), opts.audio?.encode(seq) ?? Promise.resolve()]);
    check();
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw err;
  }
}
