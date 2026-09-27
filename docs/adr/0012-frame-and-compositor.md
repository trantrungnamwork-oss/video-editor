# 0012 — M9: frame shape and one compositor for preview and export

- Status: Accepted
- Date: 2026-09-27

## Context

Text, subtitles, overlays, filters and transitions (M10–M13) and templates (M14) all need every
output frame to be drawn by the app, identically in the preview and in the export. Until M9 the
preview drew decoded frames with `drawWithFit('contain')` and the export let Mediabunny scale
them (`VideoSampleSource` transform). Templates also need a project-level frame shape.

## Decision

- **Model.** `Project.aspect` ('source' | '16:9' | '9:16' | '1:1' | '4:5', absent = 'source')
  and `Clip.layout` (`fit` 'contain' | 'cover', `panX`/`panY` in [-1, 1]). The frame keeps the
  first clip's short side, so export presets still never upscale (`core/frame.ts`).
- **One compositor.** `media/render/compositor.ts` draws a frame on a Canvas 2D context: black
  background, the clip placed by its layout (cover = crop of the frame's shape, moved by pan).
  The preview worker draws at screen size; the export draws at output size on an
  `OffscreenCanvas` and encodes it through Mediabunny's `CanvasSource`. Later layers are drawn by
  the same function.
- **Canvas 2D rather than WebGL** (the plan said WebGL): it is GPU-backed in Chromium and
  WebKit, already covers placement, text, images, alpha blending (crossfades) and `ctx.filter`
  colour filters, and keeps one code path. Measured cost on the dev machine: none (36.4 s vs
  36.6 s for a 60 s 1080p re-encode). WebGL stays an option if a filter proves too slow on
  phones.
- **Lossless copy** is refused when the frame shape differs from the source ("the frame shape was
  changed"); with an unchanged frame, cover/pan crop nothing, so the copy stays valid.
- Clip layout is part of the export checkpoint and `jobKey` (version 3).
- **UI.** A frame-shape picker under the preview; Fit/Fill and position sliders for the selected
  clip (commit on release, one undo step). The preview box always has the frame's shape (at most
  45 % of the screen height).

- **Fill by default (owner's choice, 2026-09-27).** `Project.fit` (default 'cover') applies to
  every clip; a Fit/Fill switch next to the frame shapes sets it for the whole project and resets
  clip overrides (pan kept). A clip's own Fit/Fill is stored only when it differs.

## Consequences

- An e2e test compares a luma grid of the preview with the same frame of the exported file
  (bars in Fit, panned crop in Fill); it failed on a real bug (non-integer crop) before passing.
- The multi-row timeline arrives with the first extra track (music, M10) rather than empty in M9.
