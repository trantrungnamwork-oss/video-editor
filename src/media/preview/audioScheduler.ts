import type { AudioChunk } from './protocol';

/** The subset of AudioContext we use; lets tests substitute a fake. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly outputLatency?: number;
  readonly baseLatency?: number;
  readonly destination: AudioNode;
  getOutputTimestamp?(): AudioTimestamp;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
}

/**
 * Schedules decoded audio chunks on an AudioContext and serves as the playback master clock:
 * media time is derived from what the speaker is outputting right now, so video follows audio.
 */
export class AudioScheduler {
  private readonly nodes = new Set<AudioBufferSourceNode>();
  private mediaT0 = 0;
  private ctxT0 = 0;
  /** Chunks that arrived too late to play in full (fully late ones are dropped). */
  lateChunks = 0;
  scheduledChunks = 0;
  /** Media time up to which audio has been scheduled. */
  scheduledUntil = 0;

  constructor(
    private readonly ctx: AudioContextLike,
    private readonly output: AudioNode = ctx.destination,
  ) {}

  /** Anchors media time `mediaT0` to context time `ctxT0` (slightly in the future). */
  start(mediaT0: number, ctxT0: number): void {
    this.stop();
    this.mediaT0 = mediaT0;
    this.ctxT0 = ctxT0;
    this.scheduledUntil = mediaT0;
  }

  schedule(chunk: AudioChunk): void {
    const frames = chunk.channels[0]?.length ?? 0;
    if (frames === 0) return;
    const duration = frames / chunk.sampleRate;
    let when = this.ctxT0 + (chunk.timestamp - this.mediaT0);
    let offset = 0;
    const now = this.ctx.currentTime;
    if (when < now) {
      offset = now - when;
      when = now;
      if (offset >= duration) {
        this.lateChunks++;
        return;
      }
      // Chunks that straddle the start point are expected; only count genuinely late ones.
      if (chunk.timestamp >= this.mediaT0) this.lateChunks++;
    }
    const buffer = this.ctx.createBuffer(chunk.channels.length, frames, chunk.sampleRate);
    chunk.channels.forEach((data, c) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, c));
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.output);
    node.onended = () => this.nodes.delete(node);
    node.start(when, offset);
    this.nodes.add(node);
    this.scheduledChunks++;
    this.scheduledUntil = Math.max(this.scheduledUntil, chunk.timestamp + duration);
  }

  /** Media time currently audible, never earlier than the anchor. */
  mediaTime(): number {
    return this.mediaT0 + Math.max(0, this.audibleContextTime() - this.ctxT0);
  }

  stop(): void {
    for (const n of this.nodes) {
      n.onended = null;
      try {
        n.stop();
      } catch {
        // Already stopped.
      }
      n.disconnect();
    }
    this.nodes.clear();
  }

  private audibleContextTime(): number {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts?.contextTime !== undefined && ts.contextTime > 0) return ts.contextTime;
    return this.ctx.currentTime - (this.ctx.outputLatency ?? this.ctx.baseLatency ?? 0);
  }
}
