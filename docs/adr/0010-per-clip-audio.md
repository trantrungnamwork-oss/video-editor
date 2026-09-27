# 0010 — M8: per-clip volume, mute and fades

- Status: Accepted
- Date: 2026-09-27

## Context

Post-MVP milestone M8: each clip gets a volume (0–200 %), mute, and fade-in/fade-out. The preview
must sound like the export, and the lossless "Original" export (ADR 0008) should stay available.

## Decision

- **Model.** `Clip.audio?: ClipAudio` (`volume`, `muted`, `fadeInSec`, `fadeOutSec`), absent when
  at the defaults, so older saved projects and unchanged clips stay byte-identical.
  `setClipAudio` clamps volume to [0, 2] and fades to the clip length; values are rounded to ms.
  Splitting keeps the fade-in on the left piece and the fade-out on the right one.
- **One envelope, two consumers.** `core/audioGain.ts` (pure) defines the gain at a clip-relative
  time: volume × linear fade-in × linear fade-out; overlapping fades on a clip shorter than both
  are limited to half the clip each. The preview worker applies it to every decoded chunk before
  posting it; the export applies it before resampling. Boosts are hard-clipped to [-1, 1].
- **Muted or zero-volume clips are not decoded** for audio in either path; they become silence
  (the same code path as clips without audio).
- **Smart cut is unaffected.** The copy export already re-encodes the audio track, so it picks up
  the envelope; the video packets are still copied.
- **Resume safety.** Clip audio settings are part of the export checkpoint and of `jobKey`
  (version 2), so a pending export never resumes with different audio.
- **UI.** A panel under the timeline toolbar edits the selected clip. Sliders keep a local draft
  and commit on release (pointer up, key up, blur): one drag = one undo step and one preview
  restart. Sliders are 44 px tall for touch. Tiles show fade ramps and a volume/mute badge.

## Consequences

- Linear amplitude fades are simple and testable; an equal-power curve can replace `gainAt`
  later without touching the pipelines.
- Keyboard slider changes commit per key press (one undo step each).
- e2e tests decode the exported audio and check the beep level of the test clip per second
  (muted, 200 %, mid-fade) for both the re-encode and the lossless export.
