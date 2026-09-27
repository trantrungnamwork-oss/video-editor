/**
 * Main-thread preview controller for a sequence of clips. Owns the playback clock and the
 * AudioContext; everything heavy (demux, decode, drawing) happens in preview.worker.ts on a
 * transferred OffscreenCanvas. All times here are timeline times.
 *
 * Clock: when any clip has decodable audio, time follows the audio actually leaving the speaker
 * (AudioScheduler); gaps without audio still advance because the AudioContext clock keeps
 * running. Otherwise it follows performance.now().
 */
import { AudioScheduler } from './audioScheduler';
import type { FromWorker, ToWorker, WorkerStats } from './protocol';
import {
  indexAt,
  schedule,
  sequenceDuration,
  type ScheduledClip,
  type SequenceClip,
} from './sequence';

/** Audio decoded ahead of the playhead. */
const AUDIO_LEAD_SEC = 1;
/** Delay between pressing play and the first audible sample, to let the first chunks arrive. */
const START_DELAY_SEC = 0.15;

export interface PlayerSnapshot {
  ready: boolean;
  playing: boolean;
  durationSec: number;
  hasAudio: boolean;
  error: string | null;
}

export interface PlayerStats extends WorkerStats {
  audioScheduledChunks: number;
  audioLateChunks: number;
}

export class PreviewPlayer {
  private readonly worker: Worker;
  private snapshot: PlayerSnapshot = {
    ready: false,
    playing: false,
    durationSec: 0,
    hasAudio: false,
    error: null,
  };
  private readonly listeners = new Set<(s: PlayerSnapshot) => void>();

  private audioCtx: AudioContext | null = null;
  private audio: AudioScheduler | null = null;
  private playId = 0;
  private perfT0 = 0;
  private mediaT0 = 0;
  /** Media time while paused (the last requested seek target). */
  private pausedAt = 0;
  private raf = 0;
  private seekId = 0;
  private shownTimestamp: number | null = null;
  /** Expected frame timestamp after pending frame steps, so rapid steps accumulate. */
  private stepBase: number | null = null;
  private pendingStats: ((s: WorkerStats) => void)[] = [];
  private disposeResolve: ((s: WorkerStats) => void) | null = null;
  private disposed = false;
  private sequence: ScheduledClip[] = [];
  private readonly fileTokens = new WeakMap<File, number>();
  private nextFileToken = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.worker = new Worker(new URL('../../workers/preview.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.update({ error: e.message || 'Preview worker crashed' });
    const offscreen = canvas.transferControlToOffscreen();
    this.send({ type: 'init', canvas: offscreen }, [offscreen]);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private tokenOf(file: File): number {
    let t = this.fileTokens.get(file);
    if (t === undefined) {
      t = this.nextFileToken++;
      this.fileTokens.set(file, t);
    }
    return t;
  }

  get state(): PlayerSnapshot {
    return this.snapshot;
  }

  /** Current media time in seconds. Cheap; call it every animation frame. */
  get currentTime(): number {
    if (!this.snapshot.playing) return this.pausedAt;
    const t = this.audio
      ? this.audio.mediaTime()
      : this.mediaT0 + (performance.now() - this.perfT0) / 1000;
    return Math.min(t, this.snapshot.durationSec);
  }

  /** Timestamp of the frame the worker last reported on screen after a seek. */
  get shownFrameTimestamp(): number | null {
    return this.shownTimestamp;
  }

  subscribe(fn: (s: PlayerSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Replaces the clip list (after any edit). Keeps the playhead where it was, clamped to the new
   * duration, and resumes playback if it was playing.
   */
  setSequence(clips: SequenceClip[]): void {
    const wasPlaying = this.snapshot.playing;
    const t = this.currentTime;
    if (wasPlaying) {
      this.stopClock();
      this.send({ type: 'pause' });
    }
    // Structured cloning makes a new File per message; tag handles so the worker can tell a
    // re-picked file from the one it already has open.
    clips = clips.map((c) => ({ ...c, fileToken: this.tokenOf(c.file) }));
    this.sequence = schedule(clips);
    const durationSec = sequenceDuration(this.sequence);
    this.send({ type: 'set-sequence', clips });
    this.update({ playing: false, durationSec, hasAudio: clips.some((c) => c.hasAudio) });
    this.pausedAt = Math.min(t, durationSec);
    this.stepBase = null;
    if (wasPlaying && this.pausedAt < durationSec - 1e-3) this.play();
    else this.send({ type: 'seek', id: ++this.seekId, t: this.pausedAt, precise: true });
  }

  /** Must be called from a user gesture on iOS so the AudioContext may start. */
  play(): void {
    if (!this.snapshot.ready || this.snapshot.playing || this.disposed) return;
    if (this.snapshot.durationSec <= 0) return;
    let from = this.pausedAt;
    if (from >= this.snapshot.durationSec - 1e-3) from = 0;
    this.mediaT0 = from;
    this.playId++;

    if (this.snapshot.hasAudio && typeof AudioContext !== 'undefined') {
      this.audioCtx ??= new AudioContext({ latencyHint: 'playback' });
      void this.audioCtx.resume();
      this.audio ??= new AudioScheduler(this.audioCtx);
      this.audio.start(from, this.audioCtx.currentTime + START_DELAY_SEC);
    } else {
      this.perfT0 = performance.now();
    }

    this.send({ type: 'play', t: from, playId: this.playId });
    this.send({ type: 'audio-credit', until: from + AUDIO_LEAD_SEC });
    this.update({ playing: true });
    this.raf = requestAnimationFrame(this.loop);
  }

  pause(): void {
    if (!this.snapshot.playing) return;
    this.pausedAt = this.currentTime;
    this.stopClock();
    this.send({ type: 'pause' });
    // Show exactly the frame at the pause point (the worker may have been between frames).
    this.send({ type: 'seek', id: ++this.seekId, t: this.pausedAt, precise: true });
    this.update({ playing: false });
  }

  /**
   * Seeks to t. `precise: false` shows the nearest preceding keyframe, which is much cheaper and
   * meant for continuous scrubbing; finish a scrub with a precise seek.
   */
  seek(t: number, precise = true): void {
    this.stepBase = null;
    const target = Math.min(Math.max(0, t), this.snapshot.durationSec);
    if (this.snapshot.playing) {
      this.stopClock();
      this.send({ type: 'pause' });
      this.update({ playing: false });
      this.pausedAt = target;
      this.play();
      return;
    }
    this.pausedAt = target;
    this.send({ type: 'seek', id: ++this.seekId, t: target, precise });
  }

  stepFrame(direction: 1 | -1): void {
    if (this.snapshot.playing) this.pause();
    const base = this.stepBase ?? this.shownTimestamp ?? this.pausedAt;
    const fps = this.sequence[indexAt(this.sequence, base)]?.frameRate ?? 30;
    const next = Math.min(Math.max(0, base + direction / fps), this.snapshot.durationSec);
    // Aim into the middle of the target frame so float rounding never lands on a neighbour.
    this.seek(next + 0.5 / fps);
    this.stepBase = next;
  }

  /** Sizes the canvas backing store to the element's CSS box, capped at the video resolution. */
  resize(cssWidth: number, cssHeight: number, dpr: number, maxWidth: number, maxHeight: number) {
    const w = cssWidth * dpr;
    const h = cssHeight * dpr;
    // No point rendering more pixels than the video has.
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    this.send({
      type: 'resize',
      width: Math.max(1, Math.round(w * scale)),
      height: Math.max(1, Math.round(h * scale)),
    });
  }

  getStats(): Promise<PlayerStats> {
    return new Promise<WorkerStats>((resolve) => {
      this.pendingStats.push(resolve);
      this.send({ type: 'stats' });
    }).then((s) => ({
      ...s,
      audioScheduledChunks: this.audio?.scheduledChunks ?? 0,
      audioLateChunks: this.audio?.lateChunks ?? 0,
    }));
  }

  /** Releases everything. Resolves with the worker's final stats (openFrames must be 0). */
  async dispose(): Promise<WorkerStats | null> {
    if (this.disposed) return null;
    this.disposed = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stopClock();
    this.listeners.clear();
    const final = await Promise.race([
      new Promise<WorkerStats>((resolve) => {
        this.disposeResolve = resolve;
        this.send({ type: 'dispose' });
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    this.worker.terminate();
    void this.audioCtx?.close();
    return final;
  }

  private readonly loop = () => {
    if (!this.snapshot.playing) return;
    const t = this.currentTime;
    if (t >= this.snapshot.durationSec - 1e-3) {
      this.pausedAt = this.snapshot.durationSec;
      this.stopClock();
      this.send({ type: 'pause' });
      this.update({ playing: false });
      return;
    }
    this.send({ type: 'tick', t });
    this.send({ type: 'audio-credit', until: t + AUDIO_LEAD_SEC });
    this.raf = requestAnimationFrame(this.loop);
  };

  private stopClock() {
    cancelAnimationFrame(this.raf);
    this.audio?.stop();
  }

  private readonly onVisibility = () => {
    // Mobile browsers throttle hidden tabs; pausing keeps audio and video from drifting apart.
    if (document.hidden) this.pause();
  };

  private onMessage(msg: FromWorker) {
    switch (msg.type) {
      case 'ready':
        this.update({ ready: true });
        break;
      case 'seeked':
        if (msg.id === this.seekId || msg.id === -1) {
          this.shownTimestamp = msg.timestamp;
          this.stepBase = null;
        }
        break;
      case 'audio':
        if (msg.playId === this.playId && this.snapshot.playing) this.audio?.schedule(msg.chunk);
        break;
      case 'ended':
        // Video ran out; the clock loop stops playback at durationSec.
        break;
      case 'stats':
        this.pendingStats.shift()?.(msg.stats);
        break;
      case 'disposed':
        this.disposeResolve?.(msg.stats);
        break;
      case 'error':
        this.update({ error: msg.message });
        break;
    }
  }

  private send(msg: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer);
  }

  private update(patch: Partial<PlayerSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) fn(this.snapshot);
  }
}
