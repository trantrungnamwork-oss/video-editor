import type { CopyAnalysis, CopyClip, CopyJob } from './copyExport';
import type { ExportJob, ExportProgress } from './exportPipeline';
import type { PresetPlan } from './plan';
import type { FromExportWorker, ToExportWorker } from './protocol';

export type ExportEvent =
  | { type: 'progress'; progress: ExportProgress; bytesWritten: number }
  | { type: 'done'; file: File }
  | { type: 'interrupted'; fraction: number; message: string }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

/** Main-thread handle on export.worker.ts (Mediabunny's encoders stay out of the main bundle). */
export class ExportClient {
  private readonly worker = new Worker(new URL('../../workers/export.worker.ts', import.meta.url), {
    type: 'module',
  });
  private nextId = 0;
  private readonly plans = new Map<number, (p: PresetPlan[]) => void>();
  private readonly analyses = new Map<number, (a: CopyAnalysis) => void>();
  private listener: ((e: ExportEvent) => void) | null = null;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<FromExportWorker>) => {
      const msg = e.data;
      if (msg.type === 'plan') {
        this.plans.get(msg.id)?.(msg.plans);
        this.plans.delete(msg.id);
      } else if (msg.type === 'analysis') {
        this.analyses.get(msg.id)?.(msg.analysis);
        this.analyses.delete(msg.id);
      } else {
        this.listener?.(msg);
      }
    };
    this.worker.onerror = (e) =>
      this.listener?.({ type: 'error', message: e.message || 'Export worker crashed' });
  }

  plan(sourceWidth: number, sourceHeight: number, fps: number): Promise<PresetPlan[]> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.plans.set(id, resolve);
      this.send({ type: 'plan', id, sourceWidth, sourceHeight, fps });
    });
  }

  /** Starts (or, with `resume`, continues from a matching checkpoint) an export. */
  start(
    job: ExportJob,
    listener: (e: ExportEvent) => void,
    opts: { resume?: boolean; faultAtSegment?: number } = {},
  ): void {
    this.listener = listener;
    this.send({
      type: 'start',
      job,
      resume: opts.resume ?? false,
      ...(opts.faultAtSegment !== undefined ? { faultAtSegment: opts.faultAtSegment } : {}),
    });
  }

  /** Can this timeline be exported losslessly by stream copy (smart cut)? */
  analyzeCopy(clips: CopyClip[]): Promise<CopyAnalysis> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.analyses.set(id, resolve);
      this.send({ type: 'analyze-copy', id, clips });
    });
  }

  startCopy(job: CopyJob, listener: (e: ExportEvent) => void): void {
    this.listener = listener;
    this.send({ type: 'start-copy', job });
  }

  cancel(): void {
    this.send({ type: 'cancel' });
  }

  dispose(): void {
    this.listener = null;
    this.worker.terminate();
  }

  private send(msg: ToExportWorker) {
    this.worker.postMessage(msg);
  }
}
