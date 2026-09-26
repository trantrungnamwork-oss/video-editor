/** Messages between PreviewPlayer (main thread) and preview.worker.ts. */

export type ToWorker =
  | { type: 'init'; file: File; canvas: OffscreenCanvas }
  | { type: 'resize'; width: number; height: number }
  | { type: 'play'; t: number; playId: number }
  | { type: 'pause' }
  | { type: 'tick'; t: number }
  | { type: 'audio-credit'; until: number }
  | { type: 'seek'; id: number; t: number; precise: boolean }
  | { type: 'stats' }
  | { type: 'dispose' };

export interface WorkerStats {
  /** Decoded frames currently alive (should be ≤ read-ahead + 1 while playing, ≤ 1 when idle). */
  openFrames: number;
  peakOpenFrames: number;
  decodedFrames: number;
  droppedFrames: number;
  /** Timestamp of the frame currently on the canvas. */
  shownTimestamp: number | null;
  canvasWidth: number;
  canvasHeight: number;
}

export interface AudioChunk {
  timestamp: number;
  sampleRate: number;
  /** One Float32Array per channel (planar). Transferred, not copied. */
  channels: Float32Array[];
}

export type FromWorker =
  | { type: 'ready'; durationSec: number; hasAudio: boolean; frameRate: number | null }
  | { type: 'seeked'; id: number; timestamp: number | null }
  | { type: 'ended' }
  | { type: 'audio'; chunk: AudioChunk; playId: number }
  | { type: 'stats'; stats: WorkerStats }
  | { type: 'disposed'; stats: WorkerStats }
  | { type: 'error'; message: string };
