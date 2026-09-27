# 0006 — Export pipeline

- Status: Accepted
- Date: 2026-09-26

## Context

M4: export the edited timeline on the device. MP4 (H.264 + AAC) by default, WebM (VP9 + Opus)
when MP4 cannot be encoded; 720p/1080p presets limited by the device's encoders; progress, ETA,
cancel; keep the screen on; save via Web Share with a download fallback. Peak RAM < 500 MB.

## Decision

**Pipeline (`src/media/export/`, runs in `export.worker.ts`)**

- For each clip: Mediabunny `VideoSampleSink` / `AudioSampleSink` over the clip's source range →
  retime to timeline time (same mapping as the preview, `preview/sequence.ts`) →
  `VideoSampleSource` / `AudioSampleSource` (WebCodecs encoders) → `Output`.
- Resizing and letterboxing into the output frame is done by the encoder source's `transform`
  (`fit: 'contain'`). Audio is converted to 48 kHz stereo by our own streaming resampler
  (`resample.ts`) before it reaches the encoder: Mediabunny's audio transform assumes one input
  format per stream and fails ("Audio parameters must remain constant") when clips with
  different rates or channel counts follow each other (field bug: a 22.05 kHz phone clip). Clips without audio, and
  gaps, are filled with silence so the audio track is continuous.
- Video and audio run as two concurrent loops so the muxer interleaves without buffering a whole
  track; `add()` back-pressure bounds the encoder queue. Only one clip's demuxer per loop is open.
- Output streams to an OPFS file through a sync access handle (positioned writes: MP4 patches
  earlier bytes). MP4 uses `fastStart: false` (moov at the end), which keeps memory flat.
  Nothing proportional to the video size is held in RAM.
- Key frame every 2 s. Bitrate: 720p 5 Mb/s, 1080p 8 Mb/s (×1.5 above 40 fps; VP9 ×0.7).

**Format and presets**

- Output size: the preset sets the short side, the first clip's display aspect the long side;
  never upscales; even dimensions.
- Per preset the worker asks Mediabunny `canEncodeVideo`/`canEncodeAudio` (i.e.
  `isConfigSupported`) for H.264 + AAC at that exact size and bitrate, then VP9 + Opus. The UI
  disables presets nothing can encode and says clearly when WebM is used and why.

**UX**

- Modal dialog; preview is paused so the export gets the decoder. Progress bar, %, bytes, ETA
  (overall rate), Cancel. Screen Wake Lock while running, re-acquired when the page becomes visible
  again; a `beforeunload` prompt guards against closing the tab.
- Done: "Share / Save to Photos" (Web Share with the file, shown only when `canShare({files})`)
  and Download. Only the latest export is kept in OPFS; a new export clears older ones, cancel or
  failure deletes the partial file.

**Verification**

- e2e exports an edited timeline, probes the downloaded file (duration, size, codecs, 48 kHz
  stereo), re-imports it and checks frame brightness at the cut to prove order and trims.

## Consequences

- Superseded in part by ADR 0007: the export is now segmented and resumable (background tabs,
  tab kills), and the project is persisted.
- MP4 is not encodable in Linux Chromium (TL-001); CI exercises the WebM path, the test adapts to
  whichever format the browser supports.
