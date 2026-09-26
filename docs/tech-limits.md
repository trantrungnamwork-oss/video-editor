# Technical limits log

Format: see CLAUDE.md §8.

## TL-001: Playwright's Chromium cannot test the MP4 (H.264 + AAC) path

- Affected platforms: CI / automated tests only
- Severity: Minor
- User impact: none directly; the default export path cannot be covered by automated e2e tests.
- Observed: bundled open-source Chromium reports H.264, HEVC and AAC as unsupported for both
  decode and encode, so the capability report falls back to WebM (VP9 + Opus). VP9/AV1/Opus are
  supported up to 4K.
- Options:
  1. Run e2e against branded Chrome (`channel: 'chrome'`) in CI. + real H.264/AAC; − extra CI
     install, still not Safari.
  2. Keep Chromium for fast CI, cover MP4 through unit tests with fakes + manual real-device runs.
     - zero setup; − the MP4 path is not exercised end-to-end automatically.
- Proposal: option 2 now, add option 1 as a separate CI job when the export milestone lands.

## TL-002: No automated coverage on real iOS Safari

- Affected platforms: iOS Safari
- Severity: Medium
- User impact: iOS-specific regressions (codec support, memory limits, OPFS quirks) can ship
  unnoticed.
- Options:
  1. Manual checklist on a real iPhone per milestone using `/debug` + "Copy JSON". + free;
     − manual.
  2. Playwright WebKit project. + automated; − WebKit on Linux ≠ iOS Safari (different codecs,
     no hardware encoders), extra browser download.
- Proposal: option 1; store each device's report JSON alongside benchmarks.

## TL-003: No cross-browser memory-pressure signal

- Affected platforms: iOS Safari (no API at all), Firefox; Chrome only partially
- Severity: Medium
- User impact: CLAUDE.md §7 asks to watch memory pressure and lower preview resolution
  automatically. Browsers give no reliable signal, so a tab can be killed (iOS) before we react.
- Facts:
  - iOS Safari exposes no `performance.memory`, no `measureUserAgentSpecificMemory()`, no pressure
    events. `navigator.deviceMemory` is Chromium-only.
  - WebCodecs always decodes at full resolution; shrinking the preview canvas saves little. The
    real levers are the number of decoded frames alive (read-ahead) and concurrent decoders.
- Options:
  1. Self-accounting budget: estimate our own footprint (live frames × bytes per frame, caches)
     from `FrameTracker` and cap it per device class (e.g. 4K clip ⇒ read-ahead 2). + works
     everywhere, deterministic; − estimates only our allocations, not the browser's.
  2. Chrome-only `performance.measureUserAgentSpecificMemory()` (we are cross-origin isolated).
     - real numbers; − Chromium only, slow (seconds), not on iOS where it matters most.
  3. Reactive degradation: on decoder errors / `QuotaExceededError`, drop read-ahead and preview
     quality, then retry. + catches real failures; − only after something went wrong.
- Proposal: 1 + 3 in M4 (export is the peak-memory path), 2 as extra telemetry on `/debug`
  only. M2 keeps the static bound (6 frames ahead) and the backing store capped at video
  resolution.

## TL-004: Resuming an export after the OS kills the tab

- Affected platforms: iOS Safari (aggressive tab eviction when backgrounded), Android Chrome
  under memory pressure
- Severity: Serious
- User impact: CLAUDE.md §7 asks for export checkpoints in OPFS so an export can resume after the
  tab is killed. Writing checkpoints is possible, but after a kill the page reloads without the
  source videos: `File` objects from the picker cannot be persisted, and the project itself is not
  persisted yet. Without the sources there is nothing to resume from.
- Options:
  1. Persist the project (OPFS JSON) and the encoded packets per segment; after a reload, ask the
     user to re-select the same videos (matched by name + size + last-modified), then continue
     encoding from the last finished segment. + no extra storage; − one extra step for the user,
     fails if they cannot find the same files.
  2. Copy every imported video into OPFS on import, persist the project, resume fully
     automatically. + seamless; − doubles storage, slow imports for big files, iOS quota limits,
     and a copy step before editing can start.
  3. No resume: keep Wake Lock + warnings, and make restart cheap (settings remembered).
     - simple, no risk of corrupt resumes; − a killed 1080p export restarts from zero.
- Proposal: option 1, built together with project persistence (which the editor needs anyway so
  a reload doesn't lose the edit). M4 ships option 3's safeguards now; the packet-log checkpoint
  lands once you approve.
- **Decision (2026-09-26): option 1.** Implemented as segmented export with checkpoints plus
  project persistence and file relinking; see ADR 0007. The same mechanism fixes exports failing
  when the tab goes to the background (codecs reclaimed): they now pause and resume.

## TL-005: Re-encoding only the partial GOPs (mixed copy + re-encode)

- Affected platforms: all (H.264/HEVC in MP4 in particular)
- Severity: Medium
- User impact: smart cut is lossless only when every cut lands on a keyframe (or the user accepts
  snapping). A single cut in the middle of a GOP means the whole timeline is re-encoded, instead
  of re-encoding just that GOP as CLAUDE.md §6.5 describes.
- Why: an MP4 track has one sample description. Frames re-encoded by WebCodecs come with the
  browser encoder's own SPS/PPS (avcC/hvcC), which differ from the camera's; WebCodecs gives no
  control over them. Copied and re-encoded frames therefore can't share one track, and players
  (including iOS Photos) mis-decode files that switch parameter sets without signalling it.
  VP9 in WebM doesn't have this problem (frames are self-describing), but iPhone/Android
  recordings are H.264/HEVC.
- Options:
  1. Keep all-or-nothing copy + "snap to keyframes" (implemented). + robust, simple,
     universally playable; − an off-keyframe cut costs a full re-encode (or a small shift).
  2. Write `avc3`/`hev1` sample entries with parameter sets in-band, so each GOP may carry its own
     SPS/PPS. Needs changes to Mediabunny's muxer (MPL-2.0: the patched files must stay MPL and be
     published) or our own MP4 writer. + true partial re-encode; − playback support for
     in-band parameter changes is uneven (older iOS/QuickTime, some Android players); significant
     work and a compatibility risk in exactly the files users share.
  3. Partial re-encode only for VP9/WebM sources. + works where the format allows; − covers
     almost no phone footage, and WebM doesn't open in iOS Photos.
- Proposal: option 1 for the MVP. Revisit option 2 after the MVP with a device compatibility
  matrix (iOS Photos, Android Gallery, WhatsApp/Zalo re-encoders).
