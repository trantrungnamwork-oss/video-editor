import type { ExportJob, ExportProgress } from './exportPipeline';
import type { PresetPlan } from './plan';

export type ToExportWorker =
  | { type: 'plan'; id: number; sourceWidth: number; sourceHeight: number; fps: number }
  | { type: 'start'; job: ExportJob; fileName: string }
  | { type: 'cancel' };

export type FromExportWorker =
  | { type: 'plan'; id: number; plans: PresetPlan[] }
  | { type: 'progress'; progress: ExportProgress; bytesWritten: number }
  | { type: 'done'; file: File }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };
