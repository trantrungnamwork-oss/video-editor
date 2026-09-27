/**
 * Export audio mix (ADR 0013): the clips' sound plus music and voice-over items, summed block by
 * block at 48 kHz stereo and fed to the encoder. Each source is a "lane" decoded lazily and
 * streamed, so memory stays at a few blocks whatever the length.
 */
import {
  AudioSample,
  AudioSampleSink,
  BlobSource,
  Input,
  type AudioSampleSource,
} from 'mediabunny';
import { applyGain, isSilent } from '../../core/audioGain';
import { itemGainAt, itemPasses, type MixContext } from '../../core/audioTrack';
import type { AudioMix, MixItem } from '../audioMix';
import { SUPPORTED_INPUT_FORMATS } from '../probe';
import { audioWindow, timelineTime, type ScheduledClip } from '../preview/sequence';
import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE } from './plan';
import { concatPlanes, Resampler } from './resample';

const RATE = AUDIO_SAMPLE_RATE;
const BLOCK_FRAMES = 4096;
/** Item gain is evaluated every this many source frames (fades and ducking change slowly). */
const GAIN_STEP = 64;

/** Resampled audio placed on the timeline, in output frames. */
interface Chunk {
  start: number;
  planes: Float32Array[];
}

const openAudio = (file: File) =>
  new Input({
    source: new BlobSource(file, { maxCacheSize: 8 * 1024 * 1024 }),
    formats: SUPPORTED_INPUT_FORMATS,
  });

/** Planar float copy of the frames [offset, offset + count) of a decoded sample. */
function planesOf(
  sample: { numberOfChannels: number; copyTo: AudioSample['copyTo'] },
  offset: number,
  count: number,
) {
  return Array.from({ length: sample.numberOfChannels }, (_, c) => {
    const plane = new Float32Array(count);
    sample.copyTo(plane, {
      planeIndex: c,
      format: 'f32-planar',
      frameOffset: offset,
      frameCount: count,
    });
    return plane;
  });
}

/** Keeps output contiguous across packets: a chunk starts where the previous one ended unless the source jumps. */
class Placer {
  private next = -Infinity;
  place(timelineSec: number, planes: Float32Array[]): Chunk | null {
    const frames = planes[0]?.length ?? 0;
    if (frames === 0) return null;
    const at = Math.round(timelineSec * RATE);
    const start = Math.abs(at - this.next) <= 2 ? this.next : at;
    this.next = start + frames;
    return { start, planes };
  }
}

/** The clips' own sound, one clip after the other (muted clips are skipped: silence). */
async function* clipLane(seq: ScheduledClip[], check: () => void): AsyncGenerator<Chunk> {
  for (const clip of seq) {
    if (!clip.hasAudio || isSilent(clip.audio)) continue;
    const input = openAudio(clip.file);
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) continue;
      let resampler: Resampler | null = null;
      const placer = new Placer();
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
          const planes = planesOf(sample, win.offset, win.count);
          applyGain(
            planes,
            sample.sampleRate,
            ts - clip.startSec,
            clip.endSec - clip.startSec,
            clip.audio,
          );
          if (!resampler || resampler.inRate !== sample.sampleRate) {
            resampler = new Resampler(sample.sampleRate, RATE, AUDIO_CHANNELS);
          }
          const chunk = placer.place(ts, resampler.process(planes));
          if (chunk) yield chunk;
        } finally {
          sample.close();
        }
      }
    } finally {
      input.dispose();
    }
  }
}

/** One music or voice item: each loop pass decoded in turn, with volume, fades and ducking. */
async function* itemLane(
  ctx: MixContext,
  item: MixItem,
  videoEnd: number,
  check: () => void,
): AsyncGenerator<Chunk> {
  const input = openAudio(item.file);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return;
    const sink = new AudioSampleSink(track);
    for (const pass of itemPasses(item, 0, videoEnd, videoEnd)) {
      // A new pass jumps back in the source: fresh resampler state.
      let resampler: Resampler | null = null;
      const placer = new Placer();
      for await (const sample of sink.samples(pass.sourceFrom, pass.sourceTo)) {
        try {
          check();
          const sr = sample.sampleRate;
          const win = audioWindow(
            sample.timestamp,
            sample.numberOfFrames,
            sr,
            pass.sourceFrom,
            pass.sourceTo,
          );
          if (!win) continue;
          const src = sample.timestamp + win.offset / sr;
          const t0 = pass.timelineStart + Math.max(0, src - pass.sourceFrom);
          const planes = planesOf(sample, win.offset, win.count);
          for (let i = 0; i < win.count; i += GAIN_STEP) {
            const g = itemGainAt(ctx, item, t0 + i / sr, videoEnd);
            const end = Math.min(win.count, i + GAIN_STEP);
            for (const p of planes) for (let k = i; k < end; k++) p[k] = (p[k] ?? 0) * g;
          }
          if (!resampler || resampler.inRate !== sr)
            resampler = new Resampler(sr, RATE, AUDIO_CHANNELS);
          const chunk = placer.place(t0, resampler.process(planes));
          if (chunk) yield chunk;
        } finally {
          sample.close();
        }
      }
    }
  } finally {
    input.dispose();
  }
}

/** Pulls a lane's chunks as the mix advances and adds the overlapping part into each block. */
class Lane {
  private cur: Chunk | null = null;
  private gen: AsyncGenerator<Chunk> | null = null;
  private done = false;

  constructor(
    private readonly startFrame: number,
    private readonly open: () => AsyncGenerator<Chunk>,
  ) {}

  async addInto(out: Float32Array[], from: number, n: number): Promise<void> {
    if (this.done || from + n <= this.startFrame) return; // not started yet: don't decode
    this.gen ??= this.open();
    for (;;) {
      if (!this.cur) {
        const r = await this.gen.next();
        if (r.done) {
          this.done = true;
          return;
        }
        this.cur = r.value;
      }
      const c = this.cur;
      const len = c.planes[0]?.length ?? 0;
      const end = c.start + len;
      if (end <= from) {
        this.cur = null;
        continue;
      }
      if (c.start >= from + n) return;
      const a = Math.max(from, c.start);
      const b = Math.min(from + n, end);
      out.forEach((o, ch) => {
        const src = c.planes[ch] ?? c.planes[0];
        if (!src) return;
        for (let f = a; f < b; f++) o[f - from] = (o[f - from] ?? 0) + (src[f - c.start] ?? 0);
      });
      if (end > from + n) return;
      this.cur = null;
    }
  }

  async close() {
    await this.gen?.return(undefined);
  }
}

/**
 * Encodes the timeline's audio: clips plus audio items, 48 kHz stereo, silence where nothing
 * plays, cut at the end of the video. `progress` gets the timeline time reached.
 */
export async function encodeAudio(
  seq: ScheduledClip[],
  mix: AudioMix,
  source: AudioSampleSource,
  check: () => void,
  progress: (t: number) => void,
) {
  const videoEnd = seq[seq.length - 1]?.endSec ?? 0;
  const total = Math.round(videoEnd * RATE);
  const lanes = [
    new Lane(0, () => clipLane(seq, check)),
    ...mix.audioItems
      .filter((item) => !isSilent(item.audio) && item.startSec < videoEnd)
      .map(
        (item) =>
          new Lane(Math.floor(item.startSec * RATE), () => itemLane(mix, item, videoEnd, check)),
      ),
  ];
  try {
    for (let f = 0; f < total; f += BLOCK_FRAMES) {
      check();
      const n = Math.min(BLOCK_FRAMES, total - f);
      const out = Array.from({ length: AUDIO_CHANNELS }, () => new Float32Array(n));
      for (const lane of lanes) await lane.addInto(out, f, n);
      for (const plane of out) {
        for (let i = 0; i < n; i++) {
          const v = plane[i] ?? 0;
          plane[i] = v > 1 ? 1 : v < -1 ? -1 : v;
        }
      }
      const sample = new AudioSample({
        data: concatPlanes(out),
        format: 'f32-planar',
        numberOfChannels: AUDIO_CHANNELS,
        sampleRate: RATE,
        timestamp: f / RATE,
      });
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
      progress((f + n) / RATE);
    }
  } finally {
    for (const lane of lanes) await lane.close();
  }
}
