import { useEffect, useState } from 'react';
import {
  detectCapabilities,
  RESOLUTIONS,
  type CapabilityReport,
  type ProbeResult,
  type ProbeStatus,
  type Resolution,
} from '../media/capabilities';
import { formatBytes } from './format';

const STATUS_STYLE: Record<ProbeStatus, { label: string; className: string }> = {
  supported: { label: '✓', className: 'text-green-400' },
  unsupported: { label: '✗', className: 'text-red-400' },
  'no-api': { label: '—', className: 'text-neutral-500' },
  error: { label: '!', className: 'text-amber-400' },
  timeout: { label: '⏱', className: 'text-amber-400' },
};

const FEATURE_LABELS: Record<keyof CapabilityReport['features'], string> = {
  crossOriginIsolated: 'Cross-origin isolated',
  sharedArrayBuffer: 'SharedArrayBuffer',
  opfs: 'OPFS',
  opfsSyncAccessHandle: 'OPFS sync handle (worker)',
  offscreenCanvasInWorker: 'OffscreenCanvas (worker)',
  webCodecsInWorker: 'WebCodecs (worker)',
  wakeLock: 'Screen Wake Lock',
  webShare: 'Web Share',
  webShareFiles: 'Web Share (video files)',
};

const RES_IDS = Object.keys(RESOLUTIONS) as Resolution[];

export function DebugPage() {
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');

  const [runId, setRunId] = useState(0);

  useEffect(() => {
    let cancelled = false;
    detectCapabilities().then(
      (r) => !cancelled && setReport(r),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const rerun = () => {
    setReport(null);
    setError(null);
    setRunId((n) => n + 1);
  };

  const copy = async () => {
    if (!report) return;
    const ok = await copyText(JSON.stringify(report, null, 2));
    setCopied(ok ? 'ok' : 'failed');
    setTimeout(() => setCopied('idle'), 2000);
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <a href="/" className="text-sm text-neutral-400">
            ← Home
          </a>
          <h1 className="text-xl font-semibold">Device capabilities</h1>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={rerun}
            disabled={!report && !error}
            className="min-h-11 rounded-lg bg-neutral-800 px-4 font-medium active:bg-neutral-700 disabled:opacity-50"
          >
            Re-run
          </button>
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!report}
            data-testid="copy-json"
            className="min-h-11 rounded-lg bg-green-600 px-4 font-medium text-white active:bg-green-700 disabled:opacity-50"
          >
            {copied === 'ok' ? 'Copied!' : copied === 'failed' ? 'Copy failed' : 'Copy JSON'}
          </button>
        </div>
      </header>

      <a
        href="/bench"
        className="mb-6 flex min-h-12 items-center justify-center rounded-lg bg-neutral-800 font-medium active:bg-neutral-700"
        data-testid="open-bench"
      >
        Export benchmark →
      </a>

      {error && <p className="rounded-lg bg-red-950 p-3 text-red-300">Detection failed: {error}</p>}
      {!report && !error && <p className="text-neutral-400">Probing device…</p>}
      {report && <ReportView report={report} />}
    </main>
  );
}

function ReportView({ report }: { report: CapabilityReport }) {
  const { exportPlan: plan } = report;
  return (
    <div className="flex flex-col gap-6" data-testid="report">
      <section
        className={`rounded-lg p-3 ${plan.container ? (plan.isFallback ? 'bg-amber-950 text-amber-200' : 'bg-green-950 text-green-200') : 'bg-red-950 text-red-200'}`}
      >
        <h2 className="font-semibold">Export</h2>
        {plan.container ? (
          <p>
            {plan.container.toUpperCase()} ({plan.videoCodec?.toUpperCase()} +{' '}
            {plan.audioCodec?.toUpperCase()}), up to {plan.maxResolution}
            {plan.isFallback && ' — fallback: MP4 (H.264 + AAC) encoding unavailable'}
          </p>
        ) : (
          <p>This device cannot encode any supported export format.</p>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Video codecs (decode / encode)</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-neutral-400">
                <th className="py-1 pr-3">Codec</th>
                {RES_IDS.map((r) => (
                  <th key={r} className="py-1 pr-3">
                    {r}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(report.video).map(([id, perRes]) => (
                <tr key={id} className="border-t border-neutral-800">
                  <td className="py-2 pr-3 font-medium uppercase">{id}</td>
                  {RES_IDS.map((r) => (
                    <td key={r} className="py-2 pr-3" title={perRes[r].codec}>
                      <Status result={perRes[r].decode} /> / <Status result={perRes[r].encode} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Audio codecs (decode / encode)</h2>
        <ul className="text-sm">
          {Object.entries(report.audio).map(([id, s]) => (
            <li key={id} className="flex justify-between border-t border-neutral-800 py-2">
              <span className="font-medium uppercase">{id}</span>
              <span>
                <Status result={s.decode} /> / <Status result={s.encode} />
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Platform features</h2>
        <ul className="text-sm">
          {(Object.keys(FEATURE_LABELS) as (keyof typeof FEATURE_LABELS)[]).map((k) => (
            <li key={k} className="flex justify-between border-t border-neutral-800 py-2">
              <span>{FEATURE_LABELS[k]}</span>
              <Status result={report.features[k]} />
            </li>
          ))}
        </ul>
      </section>

      <section className="text-sm text-neutral-400">
        <h2 className="mb-2 font-semibold text-neutral-100">Environment</h2>
        <p>
          Cores: {report.environment.hardwareConcurrency ?? '?'} · Memory:{' '}
          {report.environment.deviceMemoryGB ?? '?'} GB · DPR:{' '}
          {report.environment.devicePixelRatio ?? '?'}
        </p>
        {report.storage && (
          <p>
            Storage quota: {formatBytes(report.storage.quotaBytes)} (used{' '}
            {formatBytes(report.storage.usageBytes)})
          </p>
        )}
        <p>Probed in {report.durationMs} ms</p>
        <p className="mt-2">✓ supported · ✗ unsupported · — API missing · ! error · ⏱ timeout</p>
      </section>
    </div>
  );
}

function Status({ result }: { result: ProbeResult }) {
  const { label, className } = STATUS_STYLE[result.status];
  return (
    <span className={className} title={result.error ?? result.status} aria-label={result.status}>
      {label}
    </span>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can be missing or blocked (e.g. insecure context); fall back to execCommand.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
