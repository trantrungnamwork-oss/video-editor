/**
 * Worker-side preview engine for a sequence of clips. Demuxes and decodes on demand, keeps a
 * bounded read-ahead of decoded frames, draws onto a transferred OffscreenCanvas, and streams
 * decoded audio to the main thread. The main thread owns the clock and drives it with `tick`.
 *
 * All frame timestamps handed to the queue and the canvas are timeline times.
 */
import {
  AudioSampleSink,
  BlobSource,
  EncodedPacketSink,
  Input,
  VideoSampleSink,
  type AudioSample,
  type VideoSample,
} from 'mediabunny';
import { applyGain, isSilent } from '../../core/audioGain';
import { SUPPORTED_INPUT_FORMATS } from '../probe';
import { FrameTracker } from './frameTracker';
import { PlaybackQueue } from './playbackQueue';
import type { AudioChunk, FromWorker, ToWorker, WorkerStats } from './protocol';
import {
  audioWindow,
  indexAt,
  schedule,
  sourceTime,
  timelineTime,
  type ScheduledClip,
  type SequenceClip,
} from './sequence';

/** Decoded frames held ahead of the playhead. 1080p NV12 ≈ 3 MB each, 4K ≈ 12 MB. */
const READ_AHEAD_FRAMES = 6;
const SOURCE_CACHE_BYTES = 8 * 1024 * 1024;

type Post = (msg: FromWorker, transfer?: Transferable[]) => void;

interface OpenMedia {
  input: Input;
  videoSink: VideoSampleSink;
  keySink: EncodedPacketSink;
  audioSink: AudioSampleSink | null;
}

/** A clip iterator whose first frame is already being decoded (hides decoder start-up at cuts). */
interface Primed {
  iter: AsyncGenerator<VideoSample, void>;
  first: Promise<IteratorResult<VideoSample, void>> | null;
}

export class PreviewSession {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private sequence: ScheduledClip[] = [];
  private readonly media = new Map<string, Promise<OpenMedia>>();
  private readonly tracker = new FrameTracker();
  private current: VideoSample | null = null;
  private playback: PlaybackQueue<VideoSample> | null = null;
  private endedSent = false;
  private audioGeneration = 0;
  private audioCredit = 0;
  private wakeAudio: (() => void) | null = null;
  private droppedBefore = 0;
  /** Control ops run strictly in order. */
  private control: Promise<unknown> = Promise.resolve();
  private latestSeekId = -1;
  private pendingSize: { width: number; height: number } | null = null;

  constructor(private readonly post: Post) {}

  handle(msg: ToWorker): void {
    switch (msg.type) {
      case 'tick':
        return this.onTick(msg.t);
      case 'audio-credit':
        this.audioCredit = msg.until;
        this.wakeAudio?.();
        return;
      case 'resize':
        return this.onResize(msg.width, msg.height);
      case 'stats':
        return this.post({ type: 'stats', stats: this.stats() });
      case 'seek':
        this.latestSeekId = msg.id;
        return this.enqueue(() => (msg.id === this.latestSeekId ? this.seek(msg) : undefined));
      case 'init':
        return this.enqueue(() => this.init(msg.canvas));
      case 'set-sequence':
        return this.enqueue(() => this.setSequence(msg.clips));
      case 'play':
        return this.enqueue(() => this.play(msg.t, msg.playId));
      case 'pause':
        return this.enqueue(() => this.stopPlayback());
      case 'dispose':
        return this.enqueue(() => this.dispose());
    }
  }

  private enqueue(op: () => Promise<void> | void): void {
    this.control = this.control.then(op).catch((err: unknown) => this.fail(err));
  }

  private fail(err: unknown) {
    this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }

  private init(canvas: OffscreenCanvas) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D context unavailable on OffscreenCanvas');
    if (this.pendingSize) {
      canvas.width = this.pendingSize.width;
      canvas.height = this.pendingSize.height;
      this.pendingSize = null;
    }
    this.canvas = canvas;
    this.ctx = ctx;
    this.post({ type: 'ready' });
  }

  private async setSequence(clips: SequenceClip[]) {
    await this.stopPlayback();
    this.sequence = schedule(clips);
    const used = new Set(clips.map((c) => c.mediaId));
    for (const [id, open] of this.media) {
      if (used.has(id)) continue;
      this.media.delete(id);
      void open.then(
        (m) => m.input.dispose(),
        () => undefined,
      );
    }
    if (clips.length === 0) {
      this.current?.close();
      this.current = null;
      this.draw();
    }
  }

  private openMedia(clip: SequenceClip): Promise<OpenMedia> {
    let open = this.media.get(clip.mediaId);
    if (!open) {
      open = (async () => {
        const input = new Input({
          source: new BlobSource(clip.file, { maxCacheSize: SOURCE_CACHE_BYTES }),
          formats: SUPPORTED_INPUT_FORMATS,
        });
        const video = await input.getPrimaryVideoTrack();
        if (!video) throw new Error(`${clip.file.name}: no video track`);
        const audio = clip.hasAudio ? await input.getPrimaryAudioTrack() : null;
        return {
          input,
          videoSink: new VideoSampleSink(video),
          keySink: new EncodedPacketSink(video),
          audioSink: audio ? new AudioSampleSink(audio) : null,
        };
      })();
      this.media.set(clip.mediaId, open);
      open.catch(() => this.media.delete(clip.mediaId));
    }
    return open;
  }

  private onResize(width: number, height: number) {
    const canvas = this.canvas;
    if (!canvas) {
      this.pendingSize = { width, height };
      return;
    }
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    this.draw();
  }

  private show(sample: VideoSample) {
    if (this.current !== sample) this.current?.close();
    this.current = sample;
    this.draw();
  }

  private draw() {
    const { ctx, canvas } = this;
    if (!ctx || !canvas) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.current?.drawWithFit(ctx, { fit: 'contain' });
  }

  private async seek(msg: { id: number; t: number; precise: boolean }) {
    await this.stopPlayback();
    const i = indexAt(this.sequence, msg.t);
    const clip = this.sequence[i];
    if (!clip) {
      this.post({ type: 'seeked', id: msg.id, timestamp: null });
      return;
    }
    const m = await this.openMedia(clip);
    let target = sourceTime(clip, msg.t);
    if (target >= clip.outSec) target = Math.max(clip.inSec, clip.outSec - 1e-4);
    // Imprecise (scrubbing) seeks decode only the nearest preceding keyframe.
    if (!msg.precise) {
      const key = await m.keySink.getKeyPacket(target, { metadataOnly: true });
      if (key) target = Math.max(key.timestamp, clip.inSec);
    }
    const sample = await m.videoSink.getSample(target);
    if (sample) {
      sample.setTimestamp(timelineTime(clip, sample.timestamp));
      this.show(this.tracker.track(sample));
    }
    this.post({ type: 'seeked', id: msg.id, timestamp: this.current?.timestamp ?? null });
  }

  private async play(t: number, playId: number) {
    await this.stopPlayback();
    if (this.sequence.length === 0) return;
    this.endedSent = false;
    this.playback = new PlaybackQueue(this.videoFrom(this.sequence, t), READ_AHEAD_FRAMES, (err) =>
      this.fail(err),
    );
    void this.pumpAudio(this.sequence, t, ++this.audioGeneration, playId);
  }

  /** Decoded source frames of one clip from `fromSec`, each tracked as soon as it exists. */
  private async *clipFrames(
    clip: ScheduledClip,
    fromSec: number,
  ): AsyncGenerator<VideoSample, void> {
    const m = await this.openMedia(clip);
    for await (const s of m.videoSink.samples(fromSec, clip.outSec)) yield this.tracker.track(s);
  }

  private prime(clip: ScheduledClip, fromSec: number): Primed {
    const iter = this.clipFrames(clip, fromSec);
    const first = iter.next();
    first.catch(() => undefined); // surfaced when consumed
    return { iter, first };
  }

  /** Frames of the whole sequence from timeline time t, retimed to the timeline. */
  private async *videoFrom(seq: ScheduledClip[], t: number): AsyncGenerator<VideoSample, void> {
    const start = indexAt(seq, t);
    const first = seq[start];
    if (!first) return;
    let cur: Primed | null = this.prime(first, sourceTime(first, t));
    let next: Primed | null = null;
    try {
      for (let i = start; cur; i++) {
        const clip = seq[i];
        if (!clip) break;
        const upcoming = seq[i + 1];
        next = upcoming ? this.prime(upcoming, upcoming.inSec) : null;
        const firstResult: Promise<IteratorResult<VideoSample, void>> =
          cur.first ?? cur.iter.next();
        cur.first = null;
        for (let r = await firstResult; !r.done; r = await cur.iter.next()) {
          r.value.setTimestamp(timelineTime(clip, r.value.timestamp));
          yield r.value;
        }
        cur = next;
        next = null;
      }
    } finally {
      for (const p of [cur, next]) {
        if (!p) continue;
        void p.first?.then(
          (r) => (r.done ? undefined : r.value.close()),
          () => undefined,
        );
        void p.iter.return(undefined).catch(() => undefined);
      }
    }
  }

  private onTick(t: number) {
    const q = this.playback;
    if (!q) return;
    const frame = q.take(t);
    if (frame) this.show(frame);
    if (q.ended && !this.endedSent) {
      this.endedSent = true;
      this.post({ type: 'ended' });
    }
  }

  private async pumpAudio(seq: ScheduledClip[], from: number, generation: number, playId: number) {
    const live = () => generation === this.audioGeneration;
    try {
      for (let i = Math.max(0, indexAt(seq, from)); i < seq.length && live(); i++) {
        const clip = seq[i];
        if (!clip?.hasAudio || isSilent(clip.audio)) continue; // gap or muted: silence
        const m = await this.openMedia(clip);
        if (!m.audioSink) continue;
        const srcFrom = Math.max(clip.inSec, sourceTime(clip, from));
        for await (const sample of m.audioSink.samples(srcFrom, clip.outSec)) {
          if (!live()) {
            sample.close();
            break;
          }
          const chunk = toChunk(sample, clip, srcFrom);
          sample.close();
          if (!chunk) continue;
          const end = chunk.timestamp + (chunk.channels[0]?.length ?? 0) / chunk.sampleRate;
          this.post(
            { type: 'audio', chunk, playId },
            chunk.channels.map((c) => c.buffer),
          );
          // Back-pressure: wait until the main thread wants audio past this point.
          while (live() && end > this.audioCredit) {
            await new Promise<void>((r) => (this.wakeAudio = r));
          }
          if (!live()) break;
        }
      }
    } catch (err) {
      if (live()) this.fail(err);
    }
  }

  private async stopPlayback() {
    this.audioGeneration++;
    this.wakeAudio?.();
    const q = this.playback;
    this.playback = null;
    if (q) {
      this.droppedBefore += q.dropped;
      await q.dispose();
    }
  }

  private async dispose() {
    await this.stopPlayback();
    this.current?.close();
    this.current = null;
    for (const open of this.media.values()) {
      void open.then(
        (m) => m.input.dispose(),
        () => undefined,
      );
    }
    this.media.clear();
    this.post({ type: 'disposed', stats: this.stats() });
  }

  private stats(): WorkerStats {
    return {
      openFrames: this.tracker.open,
      peakOpenFrames: this.tracker.peak,
      decodedFrames: this.tracker.total,
      droppedFrames: this.droppedBefore + (this.playback?.dropped ?? 0),
      shownTimestamp: this.current?.timestamp ?? null,
      canvasWidth: this.canvas?.width ?? 0,
      canvasHeight: this.canvas?.height ?? 0,
      openInputs: this.media.size,
    };
  }
}

/** Planar Float32 copy of the part of `sample` inside the clip window, retimed to the timeline. */
function toChunk(sample: AudioSample, clip: ScheduledClip, fromSec: number): AudioChunk | null {
  const win = audioWindow(
    sample.timestamp,
    sample.numberOfFrames,
    sample.sampleRate,
    fromSec,
    clip.outSec,
  );
  if (!win) return null;
  const channels: Float32Array[] = [];
  for (let c = 0; c < sample.numberOfChannels; c++) {
    const plane = new Float32Array(win.count);
    sample.copyTo(plane, {
      planeIndex: c,
      format: 'f32-planar',
      frameOffset: win.offset,
      frameCount: win.count,
    });
    channels.push(plane);
  }
  const ts = sample.timestamp + win.offset / sample.sampleRate;
  applyGain(channels, sample.sampleRate, ts - clip.inSec, clip.outSec - clip.inSec, clip.audio);
  return { timestamp: timelineTime(clip, ts), sampleRate: sample.sampleRate, channels };
}
