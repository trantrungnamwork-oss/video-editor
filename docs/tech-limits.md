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
