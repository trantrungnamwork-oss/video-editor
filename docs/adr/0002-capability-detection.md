# 0002 — Capability detection

- Status: Accepted
- Date: 2026-09-26

## Context

The editor must pick decode/encode paths per device without user-agent sniffing (CLAUDE.md §3.4).
Safari, Chrome and Firefox differ widely in which codecs, resolutions and platform APIs they expose,
and support can differ between the main thread and workers.

## Decision

`src/media/capabilities.ts` produces a versioned, JSON-serialisable `CapabilityReport`:

- **Codecs:** `isConfigSupported()` for decoder and encoder, per codec (H.264, HEVC, VP9, AV1) and
  per resolution (720p/1080p/4K) using the _lowest_ codec level that covers that resolution at
  30 fps, plus AAC-LC and Opus at 48 kHz stereo. Every probe has a 5 s timeout; results are
  `supported | unsupported | no-api | error | timeout`. A `TypeError` from `isConfigSupported()`
  (invalid config for this browser) counts as `unsupported`.
- **Platform features:** cross-origin isolation, SharedArrayBuffer, OPFS (real `getDirectory()`
  call), Wake Lock, Web Share and `canShare({ files: [video/mp4] })`.
- **Worker probes:** OPFS `createSyncAccessHandle()` (real write/close/remove round-trip),
  OffscreenCanvas and WebCodecs are checked inside a dedicated worker, since that is where the heavy
  pipeline runs and where sync access handles exist.
- **Export plan:** derived from the report — MP4 (H.264 + AAC) if both encode, else WebM
  (VP9 + Opus), capped at the highest resolution the chosen video encoder accepts.
- The environment is injected (`CapabilityEnv`), so the module is unit-tested with fakes and stays
  free of React.

The UA string is copied into the report as metadata for bug reports only; nothing branches on it.

## Consequences

- `isConfigSupported()` can say "supported" and still fail at `configure()`/runtime (notably
  hardware encoders under memory pressure). The export pipeline must still handle encoder errors
  and fall back; the report is a starting point, not a guarantee.
- Hardware-acceleration preference is not probed yet; add it when we tune export performance.
