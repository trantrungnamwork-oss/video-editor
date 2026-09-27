# 0005 — Timeline model and sequence preview

- Status: Accepted
- Date: 2026-09-26
- Resolves the open question in ADR 0004 (how to preview several clips).

## Context

M3 adds a touch timeline: trim, split at playhead, delete, reorder, undo/redo, pinch zoom. The
preview must play the edited sequence seamlessly across cuts.

## Decision

**Model (`src/core/`, no React)**

- `Project` = one video track of `Clip`s played back to back; each clip is a source range
  `[inSec, outSec)` of a `MediaSource`. Immutable; every edit is a pure function returning a new
  project, or the same instance for a no-op (so no empty undo steps).
- Edit points snap to the source's frame grid; no edit may leave a clip shorter than 0.1 s.
- `History<T>`: linear undo/redo, 100 steps. One user gesture = one step: trim and reorder drags
  are previewed locally and committed once on release.
- Removing media from the library removes its clips as one undoable step. Imported, decodable
  clips are appended to the timeline automatically, in import order (probes are serial).
- Output frame size = first clip's display size; other shapes are letterboxed. (Export in M4
  follows the same rule unless decided otherwise.)

**Sequence preview: one worker, many inputs**

- The preview worker holds one Mediabunny `Input` per media used (8 MiB cache each), opened
  lazily and disposed when no clip references it. Split pieces of the same media share it.
- Playback is a single async generator over the sequence that retimes each decoded frame from
  source to timeline time, so `PlaybackQueue`, the clock and A/V sync are unchanged from M2.
- When a clip starts, the first frame of the next clip is already being decoded (a second decoder
  running ahead). This hides decoder start-up and GOP pre-roll at cuts. Cost: one extra frame and
  one extra decoder; peak open frames becomes read-ahead 6 + shown 1 + primed 1.
- Audio is cut to each clip's window with `copyTo({ frameOffset, frameCount })` and retimed; clips
  without (decodable) audio are silent gaps. The AudioContext clock keeps running through gaps.
- Every edit sends the full clip list (`set-sequence`); the player keeps the playhead, clamped to
  the new duration, and resumes if it was playing.

Rejected: one worker per clip (duplicate canvases and clocks, cross-worker sync at every cut,
more memory on iOS).

**Touch interaction**

- The playhead is fixed at the viewport centre; the track scrolls underneath with native momentum
  scrolling (`touch-action: pan-x`). Scrolling is scrubbing: keyframe seeks while moving, an exact
  seek 120 ms after scrolling stops. Touching the timeline pauses playback.
- Pinch zoom uses two-finger touch events (`preventDefault` only when two fingers are down);
  ctrl/⌘ + wheel does the same on desktop (trackpad pinch). Zoom keeps the point under the
  fingers fixed.
- Trim handles and the reorder grip have 44 px touch targets and `touch-action: none`, so they
  never fight the scroll. Reorder also has ← / → buttons, and there are keyboard shortcuts
  (S split, Delete, ⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z).
- Thumbnail tiles are fixed 16:9 at track height, each showing the nearest of the media's 12
  cached thumbnails.

## Consequences

- Multiple tracks, transitions and overlays are out of MVP scope; the single-track model keeps
  export (M4) and smart cut (M5) simple.
- Two hardware decoders run briefly around each cut. If a device limits concurrent decoders,
  priming degrades to a short stall at the cut; watch this on real iOS devices.
