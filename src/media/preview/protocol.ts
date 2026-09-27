/** Messages between PreviewPlayer (main thread) and preview.worker.ts. */
import type { AudioMix } from '../audioMix';
import type { SequenceClip } from './sequence';

export type ToWorker =
  | { type: 'init'; canvas: OffscreenCanvas }
  | { type: 'set-sequence'; clips: SequenceClip[]; mix: AudioMix }
  | { type: 'resize'; width: number; height: number }
  | { type: 'play'; t: number; playId: number }
  | { type: 'pause' }
  | { type: 'tick'; t: number }
  | { type: 'audio-credit'; until: number }
  | { type: 'seek'; id: number; t: number; precise: boolean }
  | { type: 'stats' }
  | { type: 'dispose' };

export interface WorkerStats {
  /** Decoded frames currently alive (read-ahead + shown + primed next-clip frame). */
  openFrames: number;
  peakOpenFrames: number;
  decodedFrames: number;
  droppedFrames: number;
  /** Timeline timestamp of the frame currently on the canvas. */
  shownTimestamp: number | null;
  canvasWidth: number;
  canvasHeight: number;
  /** Demuxers currently open (one per media used by the sequence). */
  openInputs: number;
}

export interface AudioChunk {
  /** Timeline time of the first frame. */
  timestamp: number;
  sampleRate: number;
  /** One Float32Array per channel (planar). Transferred, not copied. */
  channels: Float32Array[];
}

export type FromWorker =
  | { type: 'ready' }
  | { type: 'seeked'; id: number; timestamp: number | null }
  | { type: 'ended' }
  | { type: 'audio'; chunk: AudioChunk; playId: number }
  | { type: 'stats'; stats: WorkerStats }
  | { type: 'disposed'; stats: WorkerStats }
  | { type: 'error'; message: string };
