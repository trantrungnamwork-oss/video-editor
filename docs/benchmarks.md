# Benchmarks

Export time and peak memory per build and device (CLAUDE.md §9: export a 1-minute 1080p clip;
peak RAM must stay under 500 MB on phones).

How to measure:

- **Real devices:** open `/bench` on the device, enter the device name, tap **Run with test
  clip** (a 60 s 1080p clip is first encoded on the device, untimed), then **Copy result** and add
  the Markdown row below.
- **Dev machine:** `pnpm bench` (headless Chromium; appends a row here).

Columns: _Speed_ = source seconds per wall-clock second (above 1× is faster than real time).
_Peak memory_ on real devices comes from `performance.measureUserAgentSpecificMemory()` (page +
workers, Chromium only) or the JS heap; neither includes codec/GPU buffers held by other browser
processes, and Safari exposes no memory API at all (TL-003): on iOS, a tab over budget is reloaded
by the OS. `pnpm bench` instead records the OS memory (PSS) of all browser processes during the
export, codec buffers included.

Notes on the dev-machine rows: the "Original (copy)" run follows the re-encode in the same tab,
so its memory figure includes what the renderer kept from the re-encode (allocators don't return
memory right away); the copy itself decodes and encodes no video. Where the re-encode memory goes
is analysed in TL-007 (software VP9 encoder ≈ 570 MB + decoder ≈ 310 MB at 1080p).

M9 (every exported frame drawn by the Canvas 2D compositor, ADR 0012) against its baseline on the
same machine the same day: re-encode 36.4 s vs 36.6 s (0.0.0+65a9dab: 36.6 s, 1184 MB peak), i.e. no
measurable cost; peak memory +19 MB.

| Version       | Date       | Device                                                           | Mode            | Output                  | Source | Export time | Speed  | Output size | Peak memory                                                   |
| ------------- | ---------- | ---------------------------------------------------------------- | --------------- | ----------------------- | ------ | ----------- | ------ | ----------- | ------------------------------------------------------------- |
| 0.0.0+42b54e7 | 2026-09-26 | Dev machine: headless Chromium, 4 cores, 17 GB (software codecs) | Re-encode       | WEBM VP9+OPUS 1920×1080 | 60.0 s | 55.5 s      | 1.08×  | 23 MB       | 1251 MB peak, +1072 MB over idle (all browser processes, PSS) |
| 0.0.0+42b54e7 | 2026-09-26 | Dev machine: headless Chromium, 4 cores, 17 GB (software codecs) | Original (copy) | WEBM VP9 copy 1920×1080 | 60.0 s | 1.5 s       | 38.88× | 25 MB       | 913 MB peak, +735 MB over idle (all browser processes, PSS)   |
| 0.0.0+1404f9e | 2026-09-27 | Xiaomi Note 15 Pro, Android Chrome 153, 8 cores, 8 GB            | Re-encode       | MP4 AVC+AAC 1920×1080   | 60.0 s | 39.5 s      | 1.52×  | 31 MB       | 17 MB (page+workers)                                          |
| 0.0.0+1404f9e | 2026-09-27 | Xiaomi Note 15 Pro, Android Chrome 153, 8 cores, 8 GB            | Original (copy) | MP4 AVC copy 1920×1080  | 60.0 s | 8.0 s       | 7.51×  | 30 MB       | 31 MB (page+workers)                                          |
| M9 compositor | 2026-09-27 | Dev machine: headless Chromium, 4 cores, 17 GB (software codecs) | Re-encode       | WEBM VP9+OPUS 1920×1080 | 60.0 s | 36.4 s      | 1.65×  | 23 MB       | 1203 MB peak, +1024 MB over idle (all browser processes, PSS) |
| M9 compositor | 2026-09-27 | Dev machine: headless Chromium, 4 cores, 17 GB (software codecs) | Original (copy) | WEBM VP9 copy 1920×1080 | 60.0 s | 0.9 s       | 65.85× | 25 MB       | 918 MB peak, +739 MB over idle (all browser processes, PSS)   |
