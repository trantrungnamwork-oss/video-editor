# 0008 — Smart cut (lossless stream copy)

- Status: Accepted (partial scope; see TL-005)
- Date: 2026-09-26

## Context

CLAUDE.md §6.5: when cuts land on keyframes and clips share codec/parameters, copy the stream
instead of re-encoding; re-encode only GOPs cut in the middle or when parameters differ.

## Decision

**Implemented: all-or-nothing stream copy ("Original" export option).**

`media/export/copyExport.ts` analyzes the timeline in the export worker:

- Every clip's video must have an identical decoder configuration (codec string, coded size, and
  codec-private bytes such as avcC/hvcC) and the same rotation. Containers: H.264/HEVC/AV1 →
  MP4, VP9/VP8 → WebM.
- Every **in point** must be a keyframe (the frame shown at the in point is a key packet, within
  half a frame).
- Every **out point** must be the end of the media, right before a keyframe, or anywhere if the
  stream never reorders frames (no B-frames; checked on its first GOPs).
- If audio exists, the device must be able to encode AAC (MP4) or Opus (WebM).

If eligible, video packets are copied byte-for-byte in decode order, retimed onto the timeline;
leading pictures before the keyframe (open GOP) are dropped. Audio is re-encoded through the
normal pipeline (48 kHz stereo): copying AAC/Opus across cuts would leave priming glitches at
every join, and audio encoding is cheap. Output keeps the source resolution; nothing is decoded,
so it is lossless and typically 10× faster or more.

If only the cut positions prevent a copy, the dialog offers **"Snap N cuts to keyframes"**, which
moves each offending cut to the nearest keyframe (ties go earlier; the move is shown up front) as
one undoable edit, then re-analyzes. "Original" is the default when eligible; the user's explicit
choice is never overridden.

**Not implemented: mixing copied GOPs with re-encoded partial GOPs in one file.** See TL-005.

## Consequences

- A copy is fast, so it isn't segmented or checkpointed: an interruption restarts it.
- Keyframe positions depend on the camera/encoder (VP9 and phone encoders also insert keyframes
  at scene changes), so snap distances vary per clip; the UI states them before applying.
