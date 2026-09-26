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

Import clips on the home page (metadata and decodability are probed in a worker). Open `/debug` to see what the current device can decode/encode and copy the report as JSON.

See `CLAUDE.md` for project rules and `docs/adr/` for architecture decisions.

## License

MIT
