# 0004 — Preview pipeline

- Status: Accepted
- Date: 2026-09-26

## Context

M2 needs smooth playback and scrubbing of a clip, with a thumbnail strip, on mid-range phones,
without blocking the main thread (>50 ms) and without leaking `VideoFrame`s.

## Decision

**Threads**

- `preview.worker.ts` (one per open preview) owns demux + decode (Mediabunny `VideoSampleSink`,
  `AudioSampleSink`) and draws onto an `OffscreenCanvas` transferred from the page.
- The main thread (`PreviewPlayer`) owns the clock and the `AudioContext`, and drives the worker
  with a `tick` message per animation frame. It never touches pixels or decoded frames.
- `thumbnail.worker.ts` generates thumbnail strips, one clip at a time.

**Clock and A/V sync**

- With decodable audio, audio is the master clock: `AudioScheduler` anchors media time to a
  context time 150 ms in the future and derives "now" from `getOutputTimestamp().contextTime`
  (what the speaker is playing), falling back to `currentTime − outputLatency`. Video shows the
  newest frame whose timestamp ≤ that time.
- Without audio, `performance.now()` is the clock.
- Audio is streamed from the worker as planar Float32 chunks (transferred, not copied) with
  credit-based back-pressure: the main thread grants ~1 s of lead; the worker decodes no further.
- Chunks carry a `playId`, so audio still in flight from a previous play/seek is discarded.
- Hidden tab ⇒ pause (mobile browsers throttle background tabs; audio and video would drift).

**Frames**

- `PlaybackQueue` keeps at most 6 decoded frames ahead (1080p ≈ 18 MB, 4K ≈ 72 MB); late frames
  are closed and counted as dropped.
- Every decoded frame goes through `FrameTracker`, which wraps `close()` and counts live frames.
  Idle ⇒ exactly 1 open frame (the one on screen); disposed ⇒ 0, logged and asserted in e2e.
- The canvas backing store is CSS size × DPR, capped at the video's resolution.

**Seeking**

- Control messages (init/play/pause/seek/dispose) run strictly in order in the worker; a seek is
  skipped if a newer one is already queued, so scrubbing never builds a backlog.
- While dragging: keyframe-only seeks (one decode each). On release: exact frame.
- Frame stepping accumulates pending steps so rapid taps are not lost.

**Thumbnails**

- 12 thumbnails per clip, each snapped to the keyframe at or before its slot (one decode per
  thumbnail; slots sharing a keyframe share an image). JPEG, height = 56 px × min(DPR, 2).
- Cached in OPFS under `thumbnails/<sha256(name|size|lastModified|params)>/`, manifest written
  last as a commit marker. Written with `createSyncAccessHandle` (worker-only, widest support),
  falling back to `createWritable`.

**Test clips**

- `media/testClip.ts` encodes a clip with the device's own encoders (MP4 H.264/AAC, else WebM
  VP9/Opus): frame number + timecode on every frame, a white flash and a 1 kHz beep at each whole
  second. Used by e2e (real decode in Chromium) and for A/V-sync checks on real devices.

## Consequences

- One worker per preview; a timeline composing several clips (M3) will need either one worker
  per active clip or a multi-input session. Decided in M3.
- Downscaling the preview does **not** reduce decoder memory: WebCodecs decodes at full
  resolution. The read-ahead depth is the memory lever (see TL-003).
- No OPFS cache eviction yet (≈100 KB per clip). Add LRU eviction before it matters.
