# 0003 — Media import and probing

- Status: Accepted
- Date: 2026-09-26

## Context

M1 imports clips from the file system / photo library (`<input type="file" accept="video/*">`)
and must show resolution, fps, codec and duration, and flag clips the device cannot decode —
without loading whole files into memory (CLAUDE.md §3.2) and without blocking the main thread.

## Decision

- **Demuxer: Mediabunny** (`src/media/probe.ts`), restricted to MP4, QuickTime (MOV), WebM and
  Matroska. Other containers fail with `unsupported-format`; FFmpeg.wasm fallback comes later.
- **Streaming reads:** `BlobSource` with a 4 MiB cache. Measured on a synthetic 72 MB file:
  MP4 probing reads 128 KiB (moov only); WebM reads ~12 MB because Matroska has no sample table
  and frame-rate estimation walks clusters up to 256 packets. Either way the bytes stream through
  the bounded cache. A unit test guards both budgets.
- **Frame rate** comes from packet timestamps (`computeFrameRateMetrics`), never container
  metadata. `underlyingFrameRate === null` ⇒ variable frame rate warning.
- **Decodability** is checked with `VideoDecoder/AudioDecoder.isConfigSupported()` on the track's
  _actual_ decoder config (including `description`, i.e. avcC/hvcC), not a generic codec string —
  a device may support HEVC Main but not Main 10, for example.
- **Probing runs in a worker** (`src/workers/probe.worker.ts`), one file at a time. `File` objects
  are structured-cloned by reference, so no bytes are copied. Mediabunny ends up only in the
  worker bundle; the main bundle stays Mediabunny-free.
- **Warnings** (non-blocking): audio undecodable, no audio, HDR, variable frame rate. A clip whose
  video cannot be decoded is shown with an error and marked `canDecode: false`.
- **State:** Zustand store (`src/state/mediaStore.ts`) holds `File` handles plus probe results;
  the probe client is injected so the store is unit-tested without workers.
- **Tests without binary fixtures:** `src/media/testing/syntheticMedia.ts` muxes fake encoded
  packets into real MP4/MOV/WebM/MKV containers. Demuxing only needs valid container metadata, so
  these exercise the probe path in Vitest (Node) and Playwright. The packets are not decodable.

## Licensing

Mediabunny is **MPL-2.0**: file-level copyleft. Using it unmodified as a dependency in an MIT
project is compatible; if we ever patch Mediabunny's own files, those patched files must stay
MPL-2.0 and their source must be published (a public fork satisfies this).

## Consequences

- Mediabunny internally detects WebKit to avoid `Blob.stream()` bugs on iOS and falls back to
  ranged `arrayBuffer()` reads. That is inside the dependency; our code still never branches on
  the user agent.
- HDR clips (common from iPhone: HEVC 10-bit HLG / Dolby Vision) are flagged only; how preview and
  export handle HDR → SDR is decided in M2/M4.
