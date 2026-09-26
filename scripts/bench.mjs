// Runs the export benchmark (CLAUDE.md §9) in headless Chromium and appends the result to
// docs/benchmarks.md. Real-device numbers come from the /bench page on the device itself.
//
//   pnpm bench                       # 1080p, 60 s (the §9 benchmark)
//   pnpm bench -- --clip 1280x720x10@30 --label "quick check"
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const clip = opt('clip', '1920x1080x60@30');
const PORT = 4199;
const device =
  opt('label', null) ??
  `Dev machine: headless Chromium, ${cpus().length} cores, ${Math.round(totalmem() / 1e9)} GB (software codecs)`;

/**
 * Memory (bytes) of the browser and all its child processes (renderer, GPU, utility/codec
 * processes): what the OS actually sees, codec buffers included. On Linux this is PSS (shared
 * pages split between the processes that map them, so summing doesn't double-count); elsewhere
 * RSS, which overstates it.
 */
function pssOf(pid) {
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const kb = Number(/^Pss:\s+(\d+) kB/m.exec(rollup)?.[1]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

function browserTreeRss(rootPid) {
  const table = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number));
  const inTree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of table) {
      if (!inTree.has(pid) && inTree.has(ppid)) {
        inTree.add(pid);
        grew = true;
      }
    }
  }
  return table
    .filter(([pid]) => inTree.has(pid))
    .reduce((sum, [pid, , rss]) => sum + (pssOf(pid) ?? rss * 1024), 0);
}

const run = (cmd, a) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, a, { stdio: 'inherit' });
    p.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${a.join(' ')} failed`)),
    );
  });

await run('pnpm', ['build']);
const server = spawn('pnpm', ['preview', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
});
try {
  await new Promise((r) => setTimeout(r, 2000));
  const browserServer = await chromium.launchServer();
  const browser = await chromium.connect(browserServer.wsEndpoint());
  const rootPid = browserServer.process().pid;
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  const baseline = browserTreeRss(rootPid);
  // Only while exporting: the untimed test-clip generation before it is not part of the benchmark.
  let exporting = false;
  let peakRss = 0;
  const rssTimer = setInterval(() => {
    try {
      if (exporting) peakRss = Math.max(peakRss, browserTreeRss(rootPid));
    } catch {
      // process list unavailable for a moment
    }
  }, 250);
  const phaseTimer = setInterval(async () => {
    const text =
      (await page
        .getByTestId('bench-status')
        .textContent()
        .catch(() => '')) ?? '';
    exporting = /Re-encoding|Lossless/.test(text);
  }, 200);
  await page.goto(`http://localhost:${PORT}/bench?auto=1&clip=${clip}`);
  await page.getByPlaceholder('Device').fill(device);
  const status = page.getByTestId('bench-status');
  const timer = setInterval(
    async () => console.log(await status.textContent().catch(() => '')),
    10_000,
  );
  await page
    .getByTestId('bench-json')
    .waitFor({ timeout: 60 * 60_000 })
    .finally(() => clearInterval(timer));
  const result = JSON.parse((await page.getByTestId('bench-json').textContent()) ?? '{}');
  clearInterval(rssTimer);
  clearInterval(phaseTimer);
  await browser.close();
  await browserServer.close();
  const kind = pssOf(rootPid) === null ? 'RSS' : 'PSS';
  console.log(
    `Browser ${kind}: baseline ${Math.round(baseline / 1e6)} MB, peak ${Math.round(peakRss / 1e6)} MB`,
  );

  const mb = (b) => (b == null ? 'n/a' : `${Math.round(b / 1e6)} MB`);
  const rows = result.results.map(
    (r) =>
      `| ${result.version} | ${result.date.slice(0, 10)} | ${device} | ${r.mode === 'original' ? 'Original (copy)' : 'Re-encode'} | ${r.format} | ${r.sourceSec.toFixed(1)} s | ${r.exportSec.toFixed(1)} s | ${r.speed.toFixed(2)}× | ${mb(r.outputBytes)} | ${mb(peakRss)} peak, +${mb(peakRss - baseline)} over idle (all browser processes, ${kind}) |`,
  );
  const path = new URL('../docs/benchmarks.md', import.meta.url);
  const doc = await readFile(path, 'utf8');
  await writeFile(path, doc.trimEnd() + '\n' + rows.join('\n') + '\n');
  console.log(rows.join('\n'));
} finally {
  server.kill();
}
