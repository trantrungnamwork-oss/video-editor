# 0013 — M10: music and voice-over rows

- Status: Accepted
- Date: 2026-09-27

## Decision

- **Model** (`core/audioTrack.ts`, pure): `Project.audioItems` — music or voice items with a
  timeline start, a length (`null` = to the end of the video), a source range, looping and the
  same volume/mute/fade settings as clips. Music defaults to "from 0, repeat to the end"; a
  voice-over plays once at its recorded length. Everything is cut at the end of the video.
  Ducking (`Project.duck`, default on) lowers music to 30 % while a voice-over plays, with 0.3 s
  ramps. Items are part of the undo history and the saved project.
- **Import**: audio-only files (MP3, M4A/AAC, WAV, OGG/Opus, FLAC, WebM audio) are probed as
  `kind: 'audio'` and never become clips; they go on the rows only when picked for them ("Add
  music", or "+ Music" in the library). The vault keeps copies like videos (ADR 0011).
- **Voice-over**: `MediaRecorder` on the mic (echo cancellation on), from the playhead, while the
  preview plays muted (a gain node in the player) so the speaker isn't re-recorded. The first
  recordable format is chosen by `MediaRecorder.isTypeSupported` (WebM/Opus, MP4, Ogg).
- **Built-in music**: three loops (Calm, Upbeat, Ambient) synthesized on the device by our own
  code in a worker and added as WAV files — no third-party recordings, no licence to track,
  nothing added to the download. Replacing them with CC0 recordings later only changes the file
  source.
- **One mix, two consumers.** Export: `media/export/audioMixer.ts` pulls one lane per source
  (the clips in order, then each item, each loop pass decoded in turn), resamples to 48 kHz
  stereo, sums 4096-frame blocks and hard-clips; lanes start decoding only when the mix reaches
  them. Preview: the worker runs one pump per item next to the clips' pump and WebAudio sums
  the chunks; all pumps share the credit-based back-pressure. Gains come from the same pure
  functions, so preview and export sound the same.
- The lossless copy export keeps copying video and mixes the items into its re-encoded audio.
  Items are part of the export checkpoint and `jobKey` (version 4).

## Consequences

- e2e: a 440 Hz tone as music plus a voice-over recorded from Chromium's fake mic (silence):
  the export's level is 0.2 before, ~0.06 under the voice, 0.2 after, and the 2 s tone loops.
  Disabling ducking makes the test fail.
- Voice-over quality depends on the phone's mic processing; latency between the preview and the
  mic (tens of ms) is not compensated yet.
