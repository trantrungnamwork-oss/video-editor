import type { ExportJob, ExportProgress } from './exportPipeline';
import type { PresetPlan } from './plan';

export type ToExportWorker =
  | { type: 'plan'; id: number; sourceWidth: number; sourceHeight: number; fps: number }
  /** `resume`: keep a matching checkpoint instead of starting over. */
  | { type: 'start'; job: ExportJob; resume: boolean; faultAtSegment?: number }
  | { type: 'cancel' };

export type FromExportWorker =
  | { type: 'plan'; id: number; plans: PresetPlan[] }
  | { type: 'progress'; progress: ExportProgress; bytesWritten: number }
  | { type: 'done'; file: File }
  /** Recoverable: the checkpoint is kept; send `start` with resume to continue. */
  | { type: 'interrupted'; fraction: number; message: string }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };
