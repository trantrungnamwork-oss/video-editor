import { isReadError, unreadableFiles } from '../../media/fileAccess';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExportClient, type ExportEvent } from '../../media/export/exportClient';
import type { CopyAnalysis, CopyClip, CopyJob, CutSnap } from '../../media/export/copyExport';
import type { Checkpoint, ExportJob } from '../../media/export/exportPipeline';
import {
  AUDIO_BITRATE,
  estimateRemainingSec,
  exportFileName,
  type Preset,
  type PresetPlan,
} from '../../media/export/plan';
import { formatBytes, formatDuration } from '../format';
import { useWakeLock } from './useWakeLock';

interface Props {
  clips: CopyClip[];
  durationSec: number;
  sourceWidth: number;
  sourceHeight: number;
  fps: number;
  /** Why a lossless copy is impossible regardless of the streams (e.g. the frame was reshaped). */
  copyBlocked?: string | null;
  /** Continue this unfinished export instead of starting a new one. */
  resumeFrom?: Checkpoint | null;
  /** Applies keyframe snaps to the timeline (one undoable edit); the dialog then re-analyzes. */
  onSnapCuts?: (snaps: CutSnap[]) => void;
  onClose: () => void;
}

type RunJob = { kind: 'encode'; job: ExportJob } | { kind: 'copy'; job: CopyJob };
type Choice = Preset | 'original';

type Phase =
  | { kind: 'planning' }
  | { kind: 'choose' }
  | { kind: 'running'; startedAt: number; startFraction: number; fraction: number; bytes: number }
  | { kind: 'paused'; fraction: number; message: string }
  | { kind: 'done'; file: File; elapsedSec: number }
  | { kind: 'error'; message: string };

/** Consecutive interruptions without progress before giving up. */
const MAX_STALLED_RETRIES = 3;
const RETRY_DELAY_MS = 800;

const FORMAT_LABEL = { mp4: 'MP4 (H.264 + AAC)', webm: 'WebM (VP9 + Opus)' } as const;
const BTN = 'min-h-11 rounded-lg px-4 font-medium disabled:opacity-40';

/** Test hook: `?exportfault=N` makes segment N fail once, to exercise resume. */
function faultAtSegment(): number | undefined {
  const v = new URLSearchParams(location.search).get('exportfault');
  return v === null ? undefined : Number(v);
}

export function ExportDialog(props: Props) {
  const { durationSec, onClose, resumeFrom } = props;
  const client = useMemo(() => new ExportClient(), []);
  const [plans, setPlans] = useState<PresetPlan[]>([]);
  const [preset, setPreset] = useState<Choice | null>(null);
  const [analysis, setAnalysis] = useState<CopyAnalysis | null>(null);
  /** Once the user picks an option, late results (analysis) must not override it. */
  const userChose = useRef(false);
  const choose = (c: Choice) => {
    userChose.current = true;
    setPreset(c);
  };
  const [phase, setPhase] = useState<Phase>(() =>
    resumeFrom
      ? {
          kind: 'running',
          startedAt: performance.now(),
          startFraction: resumedFraction(resumeFrom),
          fraction: resumedFraction(resumeFrom),
          bytes: 0,
        }
      : { kind: 'planning' },
  );
  const busy = phase.kind === 'running' || phase.kind === 'paused';
  const wakeLock = useWakeLock(busy);
  const jobRef = useRef<RunJob | null>(null);
  const startedAtRef = useRef(0);
  const stalls = useRef({ count: 0, lastFraction: -1 });

  useEffect(() => () => client.dispose(), [client]);

  /** Starts the worker; the caller has already put the dialog in the running phase. */
  const launch = useCallback(
    (run: RunJob, resume: boolean) => {
      jobRef.current = run;
      const fault = faultAtSegment();
      const onEvent = (e: ExportEvent) => {
        if (e.type === 'progress') {
          setPhase((p) =>
            p.kind === 'running'
              ? { ...p, fraction: e.progress.fraction, bytes: e.bytesWritten }
              : p,
          );
        } else if (e.type === 'done') {
          setPhase({
            kind: 'done',
            file: e.file,
            elapsedSec: (performance.now() - startedAtRef.current) / 1000,
          });
        } else if (e.type === 'interrupted') {
          const s = stalls.current;
          s.count = e.fraction > s.lastFraction + 1e-6 ? 1 : s.count + 1;
          s.lastFraction = e.fraction;
          setPhase(
            s.count > MAX_STALLED_RETRIES
              ? {
                  kind: 'error',
                  message: `${e.message} (gave up after ${MAX_STALLED_RETRIES} retries)`,
                }
              : { kind: 'paused', fraction: e.fraction, message: e.message },
          );
        } else if (e.type === 'cancelled') {
          setPhase({ kind: 'choose' });
        } else {
          setPhase({ kind: 'error', message: e.message });
        }
      };
      if (run.kind === 'copy') client.startCopy(run.job, onEvent);
      else {
        client.start(run.job, onEvent, {
          resume,
          ...(fault !== undefined ? { faultAtSegment: fault } : {}),
        });
      }
    },
    [client],
  );

  const run = useCallback(
    (job: RunJob, resume: boolean, fromFraction: number) => {
      const startedAt = performance.now();
      if (!resume) startedAtRef.current = startedAt;
      setPhase({
        kind: 'running',
        startedAt,
        startFraction: fromFraction,
        fraction: fromFraction,
        bytes: 0,
      });
      launch(job, resume);
    },
    [launch],
  );

  // Resume an interrupted export as soon as the page is visible (codecs are only reliable then).
  useEffect(() => {
    if (phase.kind !== 'paused' || !jobRef.current) return;
    const job = jobRef.current;
    const from = phase.fraction;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryResume = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      timer = setTimeout(() => run(job, true, from), RETRY_DELAY_MS);
    };
    tryResume();
    document.addEventListener('visibilitychange', tryResume);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', tryResume);
    };
  }, [phase, run]);

  // Plan presets, or jump straight into a resumed export.
  useEffect(() => {
    if (resumeFrom) {
      stalls.current = { count: 0, lastFraction: resumedFraction(resumeFrom) };
      startedAtRef.current = performance.now();
      launch({ kind: 'encode', job: { ...resumeFrom.settings, clips: props.clips } }, true);
      return;
    }
    let alive = true;
    void client.plan(props.sourceWidth, props.sourceHeight, props.fps).then((p) => {
      if (!alive) return;
      setPlans(p);
      const usable = p.filter((x) => x.format && !x.upscale);
      setPreset((prev) => prev ?? usable[usable.length - 1]?.preset ?? null);
      setPhase({ kind: 'choose' });
    });
    return () => {
      alive = false;
    };
    // Planning depends only on the source; the clip list is read when starting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, resumeFrom, launch, props.sourceWidth, props.sourceHeight, props.fps]);

  // Smart cut: can this exact timeline be exported without re-encoding? Re-run after every edit
  // (e.g. after snapping cuts to keyframes).
  const clipsKey = props.clips.map((c) => `${c.clipId}:${c.inSec}:${c.outSec}`).join('|');
  const copyBlocked = props.copyBlocked ?? null;
  useEffect(() => {
    if (resumeFrom) return;
    let alive = true;
    const analysis = copyBlocked
      ? Promise.resolve<CopyAnalysis>({ eligible: false, reason: copyBlocked, snaps: [] })
      : client.analyzeCopy(props.clips);
    void analysis.then((a) => {
      if (!alive) return;
      setAnalysis(a);
      // Lossless and fast: the best default, unless the user already chose.
      if (a.eligible && !userChose.current) setPreset('original');
    });
    return () => {
      alive = false;
    };
    // clipsKey captures every clip change that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, clipsKey, resumeFrom, copyBlocked]);

  // Leaving the page would stop the export (it can be resumed after reopening, but warn anyway).
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  const chosen = plans.find((p) => p.preset === preset) ?? null;
  const original = preset === 'original' && analysis?.eligible ? analysis : null;
  const canStart = !!original || !!chosen?.format;

  const start = () => {
    stalls.current = { count: 0, lastFraction: 0 };
    if (original) {
      run(
        {
          kind: 'copy',
          job: {
            clips: props.clips,
            container: original.container,
            videoCodec: original.videoCodec,
            rotation: original.rotation,
            fileName: exportFileName(original.container),
          },
        },
        false,
        0,
      );
      return;
    }
    if (!chosen?.format) return;
    run(
      {
        kind: 'encode',
        job: {
          clips: props.clips,
          width: chosen.width,
          height: chosen.height,
          format: chosen.format,
          videoBitrate: chosen.videoBitrate,
          fileName: exportFileName(chosen.format.container),
        },
      },
      false,
      0,
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Export video"
      data-testid="export-dialog"
    >
      <div className="flex w-full max-w-md flex-col gap-4 rounded-t-2xl bg-neutral-900 p-5 sm:rounded-2xl">
        <h2 className="text-lg font-semibold">Export video</h2>

        {phase.kind === 'planning' && <p className="text-neutral-400">Checking encoders…</p>}

        {phase.kind === 'choose' && (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm text-neutral-400">Quality</legend>
              <OriginalOption
                analysis={analysis}
                checked={preset === 'original'}
                onChoose={() => choose('original')}
                onSnap={props.onSnapCuts}
              />
              {plans.map((p) => {
                const disabled = !p.format || p.upscale;
                const note = !p.format
                  ? "not supported by this device's encoder"
                  : p.upscale
                    ? 'source is smaller'
                    : `${p.width}×${p.height} · ~${formatBytes(estimateBytes(p, durationSec))}`;
                return (
                  <label
                    key={p.preset}
                    className={`flex min-h-11 items-center gap-3 rounded-lg bg-neutral-800 px-3 ${disabled ? 'opacity-40' : ''}`}
                  >
                    <input
                      type="radio"
                      name="preset"
                      value={p.preset}
                      checked={preset === p.preset}
                      disabled={disabled}
                      onChange={() => choose(p.preset)}
                      className="size-5"
                    />
                    <span className="font-medium">{p.preset}</span>
                    <span className="ml-auto text-sm text-neutral-400">{note}</span>
                  </label>
                );
              })}
            </fieldset>

            {original && (
              <p
                className="rounded bg-neutral-800 p-2 text-sm text-neutral-300"
                data-testid="export-format"
              >
                Format: {original.container.toUpperCase()} ({original.videoCodec.toUpperCase()}{' '}
                copied as recorded
                {original.audioCodec ? ` + ${original.audioCodec.toUpperCase()}` : ''}). No quality
                loss and much faster, because the video isn&apos;t re-encoded.
              </p>
            )}
            {!original && chosen?.format && (
              <p
                className={`rounded p-2 text-sm ${chosen.format.container === 'mp4' ? 'bg-neutral-800 text-neutral-300' : 'bg-amber-950 text-amber-200'}`}
                data-testid="export-format"
              >
                Format: {FORMAT_LABEL[chosen.format.container]}
                {chosen.format.container === 'webm' &&
                  ". This browser can't encode MP4 (no H.264/AAC encoder), so the video is saved as WebM. WebM may not open in the iOS Photos app."}
              </p>
            )}
            {!original && !plans.some((p) => p.format) && (
              <p className="rounded bg-red-950 p-2 text-sm text-red-300" role="alert">
                This device cannot encode video in any supported format.
              </p>
            )}

            <div className="flex gap-2">
              <button type="button" className={`${BTN} bg-neutral-800`} onClick={onClose}>
                Close
              </button>
              <button
                type="button"
                className={`${BTN} flex-1 bg-green-600 text-white active:bg-green-700`}
                disabled={!canStart}
                onClick={start}
                data-testid="export-start"
              >
                Export {formatDuration(durationSec)}
              </button>
            </div>
          </>
        )}

        {(phase.kind === 'running' || phase.kind === 'paused') && (
          <RunningView phase={phase} wakeLock={wakeLock} onCancel={() => client.cancel()} />
        )}

        {phase.kind === 'done' && (
          <DoneView file={phase.file} elapsedSec={phase.elapsedSec} onClose={onClose} />
        )}

        {phase.kind === 'error' && (
          <>
            <p className="rounded bg-red-950 p-2 text-sm text-red-300" role="alert">
              Export failed: {phase.message}
            </p>
            <FileAccessCheck message={phase.message} files={props.clips.map((c) => c.file)} />
            <div className="flex gap-2">
              <button type="button" className={`${BTN} bg-neutral-800`} onClick={onClose}>
                Close
              </button>
              {!resumeFrom && (
                <button
                  type="button"
                  className={`${BTN} flex-1 bg-neutral-700`}
                  onClick={() => setPhase({ kind: 'choose' })}
                >
                  Back
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Progress already banked in a checkpoint (video segments dominate the work). */
function resumedFraction(cp: Checkpoint): number {
  if (cp.segmentCount <= 0) return 0;
  return (0.9 * cp.segmentsDone) / cp.segmentCount + (cp.audioDone ? 0.05 : 0);
}

/** "Original": lossless smart-cut export, or why it isn't available and how to enable it. */
function OriginalOption({
  analysis,
  checked,
  onChoose,
  onSnap,
}: {
  analysis: CopyAnalysis | null;
  checked: boolean;
  onChoose: () => void;
  onSnap: ((snaps: CutSnap[]) => void) | undefined;
}) {
  const eligible = analysis?.eligible === true;
  const note = !analysis
    ? 'checking…'
    : analysis.eligible
      ? `${analysis.width}×${analysis.height} · lossless · fast`
      : analysis.reason;
  const snaps = analysis && !analysis.eligible ? analysis.snaps : [];
  const maxShift = Math.max(0, ...snaps.map((s) => s.shiftSec));
  return (
    <div className="flex flex-col gap-1" data-testid="export-original">
      <label
        className={`flex min-h-11 items-center gap-3 rounded-lg bg-neutral-800 px-3 py-2 ${eligible ? '' : 'opacity-60'}`}
      >
        <input
          type="radio"
          name="preset"
          value="original"
          checked={checked && eligible}
          disabled={!eligible}
          onChange={onChoose}
          className="size-5"
        />
        <span className="font-medium">Original</span>
        <span className="ml-auto text-right text-sm text-neutral-400">{note}</span>
      </label>
      {snaps.length > 0 && onSnap && (
        <button
          type="button"
          className="min-h-11 rounded-lg bg-neutral-700 px-3 text-left text-sm active:bg-neutral-600"
          onClick={() => onSnap(snaps)}
          data-testid="snap-cuts"
        >
          Snap {snaps.length} cut{snaps.length > 1 ? 's' : ''} to keyframes for a lossless export
          (moves {snaps.length > 1 ? 'them' : 'it'} by up to {maxShift.toFixed(2)} s)
        </button>
      )}
    </div>
  );
}

function estimateBytes(p: PresetPlan, durationSec: number) {
  return ((p.videoBitrate + AUDIO_BITRATE) * durationSec) / 8;
}

function RunningView({
  phase,
  wakeLock,
  onCancel,
}: {
  phase: Extract<Phase, { kind: 'running' | 'paused' }>;
  wakeLock: string;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(id);
  }, []);
  const fraction = Math.min(1, phase.fraction);
  const eta =
    phase.kind === 'running'
      ? estimateRemainingSec((now - phase.startedAt) / 1000, fraction, phase.startFraction)
      : null;

  return (
    <>
      <div>
        <div
          className="h-3 w-full overflow-hidden rounded-full bg-neutral-800"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)}
          data-testid="export-progress"
        >
          <div
            className={`h-full transition-[width] ${phase.kind === 'paused' ? 'bg-amber-500' : 'bg-green-500'}`}
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
        <p className="mt-2 flex justify-between font-mono text-sm tabular-nums text-neutral-300">
          <span>{Math.round(fraction * 100)}%</span>
          {phase.kind === 'running' && phase.bytes > 0 && <span>{formatBytes(phase.bytes)}</span>}
          <span data-testid="export-eta">
            {phase.kind === 'paused'
              ? 'paused'
              : eta === null
                ? 'estimating…'
                : `${formatDuration(eta).replace(/\.\d$/, '')} left`}
          </span>
        </p>
      </div>
      {phase.kind === 'paused' ? (
        <p className="rounded bg-amber-950 p-2 text-sm text-amber-200" data-testid="export-paused">
          Paused ({phase.message}). It continues from the last saved point as soon as this tab is in
          front.
        </p>
      ) : (
        <p className="rounded bg-amber-950 p-2 text-sm text-amber-200">
          Keep this tab in front until the export finishes. If you switch away, it pauses and
          continues from the last saved point when you come back.
          {wakeLock === 'active'
            ? ' The screen is being kept on.'
            : wakeLock === 'unsupported'
              ? " This browser can't keep the screen on automatically."
              : ''}
        </p>
      )}
      <button
        type="button"
        className={`${BTN} bg-neutral-800 active:bg-neutral-700`}
        onClick={onCancel}
        data-testid="export-cancel"
      >
        Cancel
      </button>
    </>
  );
}

function DoneView({
  file,
  elapsedSec,
  onClose,
}: {
  file: File;
  elapsedSec: number;
  onClose: () => void;
}) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const canShare =
    typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  const [shareError, setShareError] = useState<string | null>(null);

  const share = async () => {
    try {
      await navigator.share({ files: [file], title: file.name });
    } catch (err) {
      // AbortError = the user closed the share sheet; not an error worth showing.
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setShareError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  return (
    <>
      <p className="text-neutral-300" data-testid="export-done">
        Done: <span className="font-mono">{file.name}</span> · {formatBytes(file.size)} · took{' '}
        {formatDuration(elapsedSec).replace(/\.\d$/, '')}
      </p>
      {shareError && (
        <p className="rounded bg-red-950 p-2 text-sm text-red-300" role="alert">
          Sharing failed: {shareError}. Use Download instead.
        </p>
      )}
      <div className="flex flex-col gap-2">
        {canShare && (
          <button
            type="button"
            className={`${BTN} bg-green-600 text-white active:bg-green-700`}
            onClick={() => void share()}
          >
            Share / Save to Photos
          </button>
        )}
        <a
          href={url}
          download={file.name}
          className={`${BTN} flex items-center justify-center ${canShare ? 'bg-neutral-800' : 'bg-green-600 text-white'}`}
          data-testid="export-download"
        >
          Download
        </a>
        <button type="button" className={`${BTN} bg-neutral-800`} onClick={onClose}>
          Close
        </button>
      </div>
    </>
  );
}

/**
 * After a read error, tells whether the browser lost access to a source file (TL-009) or the
 * files are fine and the cause is elsewhere.
 */
function FileAccessCheck({ message, files }: { message: string; files: File[] }) {
  const [result, setResult] = useState<{ message: string; lost: string[] } | null>(null);
  useEffect(() => {
    if (!isReadError(message)) return;
    let alive = true;
    void unreadableFiles(files).then((lost) => {
      if (alive) setResult({ message, lost: lost.map((f) => f.name) });
    });
    return () => {
      alive = false;
    };
    // Checked once per error message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);
  if (!isReadError(message) || result?.message !== message) return null;
  return (
    <p className="text-sm text-neutral-300" data-testid="file-access-check">
      {result.lost.length > 0
        ? `The browser can no longer read ${result.lost.join(', ')}. Select the video again (Import videos), then export.`
        : 'All source videos are still readable here, so the error came from the export itself.'}
    </p>
  );
}
