# 0007 — Resumable export and project persistence

- Status: Accepted (TL-004, option 1, approved)
- Date: 2026-09-26
- Amends ADR 0006.

## Context

Field test of M4: switching to another tab during an export made it fail. Background tabs lose
their codecs (Chrome reclaims hardware encoders/decoders of background pages; iOS suspends or
kills the tab). CLAUDE.md §7 also asks that an export survive the OS killing the tab. A single
pass export can do neither.

## Decision

**Segmented, checkpointed export** (`media/export/exportPipeline.ts`)

1. Audio is encoded in one pass into `exports/job/audio.<ext>`. Audio is cheap, and segmenting it
   would leave AAC/Opus encoder priming gaps (clicks) at every seam.
2. Video is encoded as independent 10 s segments `seg-NNNN.<ext>`, each by a fresh encoder, so
   each starts with a keyframe. Frames belong to the segment in which they start.
3. After each finished file, `checkpoint.json` records progress, the job's settings and a key
   covering everything that affects the output (file identities, trims, size, codecs, bitrate).
4. The segments and the audio are stream-copied (no re-encode) into the final file. The copy
   refuses segments whose decoder configuration differs from the first (e.g. an encoder that
   changed its SPS), instead of producing a file that plays incorrectly.

Any failure while encoding a segment is treated as an interruption: the worker keeps the job
directory and reports `interrupted`. The dialog shows "paused" and resumes as soon as the page is
visible, from the last checkpoint (at most one segment of work lost). Three interruptions in a row
without progress end in an error. Cancel and non-recoverable errors delete the job.

**Project persistence** (`state/persistence.ts`)

- The project (clip ranges) and the library's probe results are saved to localStorage on every
  change (debounced, flushed on `pagehide`). The data is small JSON; no media is stored.
- On load the project is restored and every video is listed as _missing_: `File` objects from a
  picker can't be persisted. Selecting the same files again (matched by name + size +
  last-modified) relinks them under their old ids, so the timeline is intact.
- The preview and export stay disabled until every clip's file is back.

**Resume after the tab was killed**

- On load, an existing checkpoint shows a banner: Resume (enabled once the files are relinked and
  the job key matches the current timeline) or Discard.

## Consequences

- Extra disk I/O: segments are written once and copied once. Peak OPFS use during an export is
  about twice the output size until the job directory is removed.
- Export time grows slightly (one encoder start-up per 10 s, one copy pass).
- The undo history is not persisted, only the current project.
- `?exportfault=N` makes segment N fail once; it exists for the e2e test of the resume path.
