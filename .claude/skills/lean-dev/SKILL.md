---
name: lean-dev
description: Token-efficient workflow for this video editor repo. Use at the start of any coding task here (features, bug fixes, CI failures, phone-test reports) to find code without broad exploration, verify with compact output, and check CI in one call.
---

# Lean dev workflow (video-editor)

Goal: finish each task with the fewest tokens. Project rules stay in `CLAUDE.md`.

## Rules

1. **Don't explore; look up.** Use the map below, then `grep -n` for the symbol and read only
   that range (`sed -n 'A,Bp'`). Never read a whole file over ~150 lines.
2. **Edit, don't rewrite.** Use exact-string edits; batch several edits in one script.
3. **Verify compactly:** `scripts/verify.sh` (lint, format, typecheck, unit: one line per step).
   Add `e2e <file-pattern>` for the touched feature; run the full `e2e` once, before pushing.
   Never paste full test logs; failures are already trimmed to 40 lines.
4. **Format before commit.** CI runs `prettier --check .`; `verify.sh` covers it. A red CI costs
   a full rerun (~15 min), so run it even for one-line edits.
5. **CI in one call:** `list_workflow_runs` (perPage 1, branch filter). If red, use
   `get_job_logs` with `failed_only`, `tail_lines` ≤ 150. Schedule one check-in (`send_later`,
   15–20 min) after a push instead of polling, and don't cancel it until CI is green.
6. **Answer briefly.** Vietnamese to the user, ≤ 15 lines: what changed, how it was verified, what
   the user should test on the phone. No recaps of earlier work.
7. **Reproduce first.** For a bug: write the failing e2e/unit test, see it fail, then fix.
   Mutation-check new tests once (break the code, see red, restore).

## Code map

- **Model (pure):** `src/core/project.ts` (clips, trim/split, audio, layout, aspect), `frame.ts`
  (frame size, cover crop), `audioGain.ts`, `history.ts`, `timelineMath.ts`
- **State:** `src/state/projectStore.ts` (undoable edits), `mediaStore.ts` (library, vault
  copies), `persistence.ts` (localStorage + restore)
- **Preview:** `src/media/preview/previewPlayer.ts` (main thread, clock, audio),
  `previewSession.ts` (worker: decode, draw), `sequence.ts` (timeline ↔ source)
- **Render:** `src/media/render/compositor.ts` (one frame, shared by preview and export)
- **Export:** `src/media/export/exportPipeline.ts` (segments, audio, mux), `copyExport.ts`
  (lossless), `segments.ts` (`jobKey`: bump `v` when output-affecting fields change), `plan.ts`,
  `exportClient.ts` + `src/workers/export.worker.ts`
- **Storage:** `src/media/vault/vault.ts` + `src/workers/vault.worker.ts` (OPFS copies)
- **UI:** `src/ui/EditorPage.tsx` (wiring), `timeline/Timeline.tsx`, `timeline/Clip*Panel.tsx`,
  `AspectPicker.tsx`, `export/ExportDialog.tsx`, `MediaCard.tsx`
- **Tests:** unit next to source; e2e `e2e/helpers.ts` (`openWithTestClips`, `scrubTo`,
  `startReencodeExport`, `finishExportAndDownload`), `e2e/verify.ts` (`probeFile`,
  `expectFlashes`, `beepPeaks`, `previewGrid`/`exportedGrid`/`gridDistance`)
- **Docs:** `docs/adr/`, `docs/tech-limits.md` (TL-xxx), `docs/benchmarks.md`

## Facts that save a lookup

- Test clips: `?testclip=WxHxS[@FPS[:RATE[:CH]]]`; white flash + 1 kHz beep (peak 0.3) for the
  first 0.1 s of every second; frame number in the centre. Headless Chromium has no H.264/AAC:
  e2e exports are WebM (VP9 + Opus); the phone uses MP4.
- Test hooks: `?vault=off` (no OPFS copies), `?exportfault=N` (segment N fails once).
- New per-clip fields must flow through: `Clip` → `SequenceClip` (EditorPage) → `ExportClip` /
  `CopyClip` → `Checkpoint` + `jobKey`.
- Branch: `claude/claude-md-first-steps-371b0o`; commit trailers per the session reminder.
- Phone check: Xiaomi Note 15 Pro, Chrome 153 (Android). iPhone testing is deferred (TL-008).
