import { copyText } from './clipboard';
import { useEffect, useRef, useState } from 'react';
import { benchMarkdownRows, runBenchmark, type BenchRun } from '../media/bench';
import { createProbeClient } from '../media/probeClient';
import { parseTestClipSpec } from '../media/testClip';
import { requestTestClip } from '../media/testClipClient';

/**
 * Export benchmark for real devices (CLAUDE.md §9). Generates (or takes) a 1080p clip, exports it,
 * and reports time and peak memory as a row for docs/benchmarks.md. `?auto=1` runs immediately
 * (used by `pnpm bench`); `?clip=WxHxSECONDS@FPS` overrides the generated clip.
 */
export function BenchPage() {
  const params = new URLSearchParams(location.search);
  const spec = parseTestClipSpec(params.get('clip')) ?? {
    width: 1920,
    height: 1080,
    fps: 30,
    durationSec: 60,
  };
  const [status, setStatus] = useState('Ready');
  const [run, setRun] = useState<BenchRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState('');
  const started = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const start = async (picked?: File) => {
    if (started.current) return;
    started.current = true;
    setError(null);
    setRun(null);
    try {
      let file = picked;
      if (!file) {
        setStatus(
          `Encoding a ${spec.width}×${spec.height} ${spec.durationSec} s test clip (not timed)…`,
        );
        file = await requestTestClip(spec);
      }
      setStatus('Reading the clip…');
      const probe = createProbeClient();
      const info = await probe.probe(file);
      probe.dispose();
      const result = await runBenchmark(file, info, __APP_VERSION__, setStatus);
      setRun(result);
      setStatus('Done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('Failed');
    } finally {
      started.current = false;
    }
  };

  // `?auto=1`: start once on load (used by `pnpm bench`). Deferred so it isn't a synchronous
  // state update inside the effect.
  useEffect(() => {
    if (new URLSearchParams(location.search).get('auto') !== '1') return;
    const t = setTimeout(() => void start(), 0);
    return () => clearTimeout(t);
    // Runs once on mount by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = run ? benchMarkdownRows(run, device || 'device?') : [];
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const copy = async () => {
    const ok = await copyText([...rows, '', JSON.stringify(run, null, 2)].join('\n'));
    setCopied(ok ? 'ok' : 'failed');
  };

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
      <a href="/" className="text-sm text-neutral-400">
        ← Editor
      </a>
      <h1 className="text-xl font-semibold">Export benchmark</h1>
      <p className="text-sm text-neutral-400">
        Exports a {spec.durationSec} s {spec.width}×{spec.height} clip (generated with this
        device&apos;s encoder, or one you pick) and measures time and peak memory. Keep this tab in
        front and the screen on.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        Device name for the report (e.g. &quot;iPhone 13, iOS 26&quot;)
        <input
          value={device}
          onChange={(e) => setDevice(e.target.value)}
          className="min-h-11 rounded-lg bg-neutral-800 px-3"
          placeholder="Device"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          className="min-h-12 flex-1 rounded-lg bg-green-600 px-4 font-medium text-white disabled:opacity-40"
          onClick={() => void start()}
          disabled={status !== 'Ready' && status !== 'Done' && status !== 'Failed'}
          data-testid="bench-run"
        >
          Run with test clip
        </button>
        <button
          type="button"
          className="min-h-12 rounded-lg bg-neutral-800 px-4 text-sm"
          onClick={() => fileRef.current?.click()}
        >
          Pick a video
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void start(f);
            e.target.value = '';
          }}
        />
      </div>
      <p className="font-mono text-sm" data-testid="bench-status">
        {status}
      </p>
      {error && (
        <p className="rounded bg-red-950 p-2 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
      {run && (
        <>
          <table className="text-sm" data-testid="bench-results">
            <tbody>
              {run.results.map((r) => (
                <tr key={r.mode} className="border-t border-neutral-800">
                  <td className="py-2 pr-3">
                    {r.mode === 'original' ? 'Original (copy)' : 'Re-encode'}
                  </td>
                  <td className="py-2 pr-3">{r.format}</td>
                  <td className="py-2 pr-3">{r.exportSec.toFixed(1)} s</td>
                  <td className="py-2 pr-3">{r.speed.toFixed(2)}×</td>
                  <td className="py-2">
                    {r.peakMemoryBytes === null
                      ? 'memory n/a'
                      : `${Math.round(r.peakMemoryBytes / 1e6)} MB`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            className="min-h-11 rounded-lg bg-neutral-800 px-4"
            onClick={() => void copy()}
            data-testid="bench-copy"
          >
            {copied === 'ok'
              ? 'Copied!'
              : copied === 'failed'
                ? 'Copy failed: long-press the text below to copy it'
                : 'Copy result (Markdown + JSON)'}
          </button>
          <pre
            className="overflow-x-auto rounded bg-neutral-900 p-2 text-xs select-all"
            data-testid="bench-json"
          >
            {JSON.stringify(run)}
          </pre>
        </>
      )}
    </main>
  );
}
