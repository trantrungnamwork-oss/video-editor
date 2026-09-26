/**
 * Worker-side preview engine: demuxes and decodes one clip, keeps a bounded read-ahead of decoded
 * frames, draws onto a transferred OffscreenCanvas, and streams decoded audio to the main thread.
 * The main thread owns the clock and drives it with `tick` messages.
 */
import {
  AudioSampleSink,
  BlobSource,
  EncodedPacketSink,
  Input,
  VideoSampleSink,
  type AudioSample,
  type InputVideoTrack,
  type VideoSample,
} from 'mediabunny';
import { SUPPORTED_INPUT_FORMATS } from '../probe';
import { FrameTracker } from './frameTracker';
import { PlaybackQueue } from './playbackQueue';
import type { AudioChunk, FromWorker, ToWorker, WorkerStats } from './protocol';

/** Decoded frames held ahead of the playhead. 1080p NV12 ≈ 3 MB each, 4K ≈ 12 MB. */
const READ_AHEAD_FRAMES = 6;
const SOURCE_CACHE_BYTES = 16 * 1024 * 1024;

type Post = (msg: FromWorker, transfer?: Transferable[]) => void;

interface Loaded {
  input: Input;
  video: InputVideoTrack;
  videoSink: VideoSampleSink;
  keySink: EncodedPacketSink;
  audioSink: AudioSampleSink | null;
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  durationSec: number;
}

export class PreviewSession {
  private loaded: Loaded | null = null;
  private readonly tracker = new FrameTracker();
  private current: VideoSample | null = null;
  private playback: PlaybackQueue<VideoSample> | null = null;
  private endedSent = false;
  private audioGeneration = 0;
  private audioCredit = 0;
  private wakeAudio: (() => void) | null = null;
  private droppedBefore = 0;
  /** Control ops (init/play/pause/seek/dispose) run strictly in order. */
  private control: Promise<unknown> = Promise.resolve();
  private latestSeekId = -1;
  /** Size requested before init finished; applied once the canvas is ours. */
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
        return this.enqueue(() => this.init(msg.file, msg.canvas));
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

  private async init(file: File, canvas: OffscreenCanvas) {
    const input = new Input({
      source: new BlobSource(file, { maxCacheSize: SOURCE_CACHE_BYTES }),
      formats: SUPPORTED_INPUT_FORMATS,
    });
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('No video track');
    const audio = await input.getPrimaryAudioTrack();
    const hasAudio = !!audio && (await audio.canDecode());
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D context unavailable on OffscreenCanvas');
    const [durationSec, fps] = await Promise.all([
      input.computeDuration(),
      video.computeFrameRateMetrics().then(
        (m) => m.bestGuessFrameRate,
        () => null,
      ),
    ]);
    this.loaded = {
      input,
      video,
      videoSink: new VideoSampleSink(video),
      keySink: new EncodedPacketSink(video),
      audioSink: hasAudio && audio ? new AudioSampleSink(audio) : null,
      canvas,
      ctx,
      durationSec,
    };
    if (this.pendingSize) {
      canvas.width = this.pendingSize.width;
      canvas.height = this.pendingSize.height;
      this.pendingSize = null;
    }
    this.post({ type: 'ready', durationSec, hasAudio, frameRate: fps });
    await this.seek({ id: -1, t: 0, precise: true });
  }

  private onResize(width: number, height: number) {
    if (!this.loaded) {
      this.pendingSize = { width, height };
      return;
    }
    const { canvas } = this.loaded;
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
    if (!this.loaded || !this.current) return;
    const { ctx, canvas } = this.loaded;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.current.drawWithFit(ctx, { fit: 'contain' });
  }

  private async seek(msg: { id: number; t: number; precise: boolean }) {
    const l = this.loaded;
    if (!l) return;
    await this.stopPlayback();
    const t = clamp(msg.t, 0, l.durationSec);
    // Imprecise (scrubbing) seeks decode only the nearest preceding keyframe.
    let target = t;
    if (!msg.precise) {
      const key = await l.keySink.getKeyPacket(t, { metadataOnly: true });
      if (key) target = key.timestamp;
    }
    const sample = (await l.videoSink.getSample(target)) ?? (await l.videoSink.getSample(0));
    if (sample) this.show(this.tracker.track(sample));
    this.post({ type: 'seeked', id: msg.id, timestamp: this.current?.timestamp ?? null });
  }

  private async play(t: number, playId: number) {
    const l = this.loaded;
    if (!l) return;
    await this.stopPlayback();
    this.endedSent = false;
    const tracker = this.tracker;
    const source = (async function* () {
      for await (const s of l.videoSink.samples(t)) yield tracker.track(s);
    })();
    this.playback = new PlaybackQueue(source, READ_AHEAD_FRAMES, (err) => this.fail(err));
    if (l.audioSink) void this.pumpAudio(l.audioSink, t, ++this.audioGeneration, playId);
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

  private async pumpAudio(sink: AudioSampleSink, from: number, generation: number, playId: number) {
    const live = () => generation === this.audioGeneration;
    try {
      for await (const sample of sink.samples(from)) {
        if (!live()) {
          sample.close();
          break;
        }
        const chunk = toChunk(sample);
        const end = sample.timestamp + sample.duration;
        sample.close();
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
    this.loaded?.input.dispose();
    this.loaded = null;
    this.post({ type: 'disposed', stats: this.stats() });
  }

  private stats(): WorkerStats {
    return {
      openFrames: this.tracker.open,
      peakOpenFrames: this.tracker.peak,
      decodedFrames: this.tracker.total,
      droppedFrames: this.droppedBefore + (this.playback?.dropped ?? 0),
      shownTimestamp: this.current?.timestamp ?? null,
      canvasWidth: this.loaded?.canvas.width ?? 0,
      canvasHeight: this.loaded?.canvas.height ?? 0,
    };
  }
}

function toChunk(sample: AudioSample): AudioChunk {
  const channels: Float32Array[] = [];
  for (let c = 0; c < sample.numberOfChannels; c++) {
    const opts = { planeIndex: c, format: 'f32-planar' } as const;
    const plane = new Float32Array(sample.allocationSize(opts) / 4);
    sample.copyTo(plane, opts);
    channels.push(plane);
  }
  return { timestamp: sample.timestamp, sampleRate: sample.sampleRate, channels };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
