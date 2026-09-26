# Benchmarks

Export time and peak RAM for a 1-minute 1080p clip, per release (CLAUDE.md §9).
The benchmark script arrives with the export milestone.

Notes on the dev-machine rows: the "Original (copy)" run follows the re-encode in the same tab,
so its memory figure includes what the renderer kept from the re-encode (allocators don't return
memory right away); the copy itself decodes and encodes no video. Where the re-encode memory goes
is analysed in TL-007 (software VP9 encoder ≈ 570 MB + decoder ≈ 310 MB at 1080p).

| Version       | Device     | Browser                                                          | Container       | Export time             | Peak RAM | Notes  |
| ------------- | ---------- | ---------------------------------------------------------------- | --------------- | ----------------------- | -------- | ------ |
| —             | —          | —                                                                | —               | —                       | —        | —      |
| 0.0.0+42b54e7 | 2026-09-26 | Dev machine: headless Chromium, 4 cores, 17 GB (software codecs) | Re-encode       | WEBM VP9+OPUS 1920×1080 | 60.0 s   | 55.5 s | 1.08×  | 23 MB | 1251 MB peak, +1072 MB over idle (all browser processes, PSS) |
| 0.0.0+42b54e7 | 2026-09-26 | Dev machine: headless Chromium, 4 cores, 17 GB (software codecs) | Original (copy) | WEBM VP9 copy 1920×1080 | 60.0 s   | 1.5 s  | 38.88× | 25 MB | 913 MB peak, +735 MB over idle (all browser processes, PSS)   |
