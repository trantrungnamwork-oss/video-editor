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
