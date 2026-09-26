# Video Editor

Free, open-source video editor that runs entirely in the browser. No backend, no accounts, no
uploads — videos never leave your device. Mobile-first (iOS Safari, Android Chrome), installable
as a PWA.

## Development

```sh
pnpm install
pnpm dev          # http://localhost:5173 (cross-origin isolated)
pnpm test         # unit tests (Vitest)
pnpm test:e2e     # Playwright: desktop, Pixel 7, iPhone 15 profiles
pnpm lint && pnpm typecheck
pnpm build        # static output in dist/, deploy to Cloudflare Pages
```

Import clips on the home page (metadata and decodability are probed in a worker), then tap
**Preview** to play and scrub. **Add test clip** encodes a clip on the device itself (frame
numbers, 1 kHz beep + white flash every second) for A/V-sync and performance checks. Open `/debug` to see what the current device can decode/encode and copy the report as JSON.

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
