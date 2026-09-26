# 0001 — Toolchain and project skeleton

- Status: Accepted
- Date: 2026-09-26

## Context

CLAUDE.md §4 fixes the stack: pnpm, Vite, React, strict TypeScript, Tailwind, vite-plugin-pwa,
Vitest, Playwright. A few version and layout choices had to be made on top of that.

## Decision

- **TypeScript 6.0, not 7.x.** `typescript-eslint` 8.x declares `typescript <6.1.0` as its peer
  range. Revisit once typescript-eslint supports the native (Go) compiler.
- **Extra strictness:** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` on top of `strict`.
  Media code juggles many optional fields (codec configs, frame metadata); both flags catch real bugs.
- **Layer boundary enforced by lint:** `src/core/**` and `src/media/**` may not import React,
  `ui/` or `state/` (`no-restricted-imports` in `eslint.config.js`).
- **No router yet.** Two routes (`/`, `/debug`) are dispatched on `location.pathname`. Cloudflare
  Pages serves `index.html` for unknown paths when no `404.html` exists, so deep links work.
- **Cross-origin isolation** via `public/_headers` (COOP `same-origin`, COEP `require-corp`),
  mirrored in the Vite dev/preview server so local behaviour matches production.
- **Playwright pinned to 1.56.x** to match the Chromium build preinstalled in our CI/cloud
  containers. Projects: desktop Chromium, Pixel 7, iPhone 15 (viewport/touch emulation on Chromium).

## Consequences

- Emulated mobile profiles validate layout and touch targets only; codec support always comes from
  the host browser. Real-device testing stays mandatory (see TL-002).
- Bumping TypeScript or Playwright is a deliberate change, not a routine `pnpm up`.
