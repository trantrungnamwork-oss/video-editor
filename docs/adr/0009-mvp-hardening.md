# 0009 — M6: benchmark, input formats, PWA

- Status: Accepted
- Date: 2026-09-26

## Decision

**Benchmark (CLAUDE.md §9)**

- `/bench` runs on any device: it encodes a 60 s 1080p test clip with the device's own encoder
  (untimed), then times a 1080p re-encode export and, when possible, a lossless copy export, and
  samples peak memory. "Copy result" yields the Markdown row for `docs/benchmarks.md`.
- In-page memory: `performance.measureUserAgentSpecificMemory()` (page + workers; Chromium,
  cross-origin isolated), falling back to the JS heap when a build refuses it (headless Chromium
  does). Neither sees codec/GPU buffers; Safari exposes nothing (TL-003).
- `pnpm bench` runs the same page in headless Chromium and records the **OS resident memory of
  all browser processes during the export** (renderer, GPU, utility), which does include codec
  buffers, then appends the row to `docs/benchmarks.md`.

**Input formats**

- MPEG-TS (.ts/.mts/.m2ts) added to the demuxed containers (Mediabunny). No FFmpeg.wasm: the
  published build is GPL (TL-006); unsupported files get a message listing supported formats.

**PWA**

- PNG icons (192, 512, maskable 512, 180 apple-touch-icon) rendered from `icon.svg` by
  `pnpm icons`; iOS ignores SVG touch icons and Chrome's install criteria want PNGs.
- The service worker precaches the app shell, all worker bundles, icons and the manifest. An e2e
  test goes offline after the first visit and still encodes a clip, probes it, previews it, and
  deep-links to `/debug`.
- Deterministic export failures still go through the pause/retry path (up to 3 attempts) before
  surfacing; acceptable, since the message is shown in the end.
