# Video Editor

Free, open-source video editor that runs entirely in the browser. No backend, no accounts, no
uploads — videos never leave your device. Mobile-first (iOS Safari, Android Chrome), installable
as a PWA.

## Requirements

A current Chrome/Edge, Android Chrome or iOS Safari 26+. Phones use hardware video codecs; on
computers without hardware VP9/H.264 encoding (e.g. Linux, Firefox) a 1080p export needs about
1 GB of free RAM (TL-007). Supported inputs: MP4, MOV, WebM, MKV, MPEG-TS (TL-006: no FFmpeg).

## Development

```sh
pnpm install
pnpm dev          # http://localhost:5173 (cross-origin isolated)
pnpm test         # unit tests (Vitest)
pnpm test:e2e     # Playwright: desktop, Pixel 7, iPhone 15 profiles
pnpm lint && pnpm typecheck
pnpm build        # static output in dist/, deploy to Cloudflare Pages
```

Import clips (metadata and decodability are probed in a worker); they land on the timeline
automatically. Scroll the timeline to scrub, pinch to zoom, tap a clip to select it, drag its
yellow edges to trim or its ⠿ grip to reorder; split, delete and undo/redo are in the toolbar.
The selected clip's volume (0–200 %), mute and fade-in/out are set under the toolbar.
The frame shape (original, 16:9, 9:16, 1:1, 4:5) is picked under the preview; clips fill it
(cropped) by default, or Fit it (bars) — for all clips next to the shapes, or per clip in its
panel with position sliders.
**Add music** (your audio files or three built-in loops generated on the device) plays from the
start and repeats to the end; **Record voice** records from the playhead while the video plays
muted, and the music dips under it. Both sit on their own rows under the clips.
**Export → Original** copies the video without re-encoding (lossless, fast) when all cuts are on
keyframes; the dialog offers to snap the cuts that aren't. Otherwise **Export** encodes the timeline
on the device (MP4 H.264/AAC, or WebM VP9/Opus where MP4 is not
available) at 720p or 1080p, then shares it (Save to Photos on phones) or downloads it. If the tab
goes to the background the export pauses and resumes. Imported videos are copied into the app's
own storage (when there is room), so after the tab is closed the project, its videos and an
unfinished export are all still there.
**Add test clip** encodes a clip on the device itself (frame numbers, 1 kHz beep + white flash
every second) for A/V-sync and performance checks. Open `/debug` to see what the current device can decode/encode and copy the report as JSON.

See `CLAUDE.md` for project rules and `docs/adr/` for architecture decisions.

## Deploy (Cloudflare Pages)

`.github/workflows/ci.yml` runs lint, typecheck, unit tests, build and Playwright on every push,
then deploys `dist/` to Cloudflare Pages (project `video-editor`, created on first run).
`main` is production; every other branch gets a preview URL (see the job summary).

One-time setup, in GitHub → Settings → Secrets and variables → Actions:

- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare dashboard → Workers & Pages → Account ID (right sidebar).
- `CLOUDFLARE_API_TOKEN`: My Profile → API Tokens → Create Token → Custom token with
  **Account › Cloudflare Pages › Edit**.

Without these secrets the deploy job is skipped with a notice; CI still runs. HTTPS is required:
WebCodecs and OPFS only work in secure contexts, so phones cannot test over plain LAN HTTP.

## License

MIT
