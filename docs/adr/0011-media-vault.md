# 0011 — Keep the app's own copy of imported videos (OPFS vault)

- Status: Accepted
- Date: 2026-09-27

## Context

A `File` from the picker is only a handle to the user's file. The browser forgets it on reload,
so every reopen asked the user to find the videos again in the phone's gallery (ADR 0007), and
Android Chrome can stop letting us read it mid-session (TL-009: exports failed with
`network error`). The owner chose TL-009 option 3.

## Decision

- After a video is probed and is decodable on the device, a dedicated worker streams it into
  OPFS as `media/<media id>` with a sync access handle (one copy at a time, no full-file buffer).
  When done, the library item's `File` is swapped for the stored copy, wrapped in a `File` with
  the original name, type and modification date, so relink matching, export checkpoints
  (`jobKey`) and the UI keep working unchanged. The preview reopens it (new handle token).
- Before copying, `navigator.storage.estimate()` must leave 512 MB free after the copy (room for
  exports and the browser), or 10 % of the quota when the quota is small (private windows, CI
  browsers: a fixed 512 MB refused every copy there); otherwise the copy is skipped and the video behaves as before
  (select it again after a reload). The first copy asks for `navigator.storage.persist()`.
- The saved project marks stored videos. On startup the app reopens their copies before the
  first render (size must match, otherwise the video is listed as missing) and deletes copies
  nothing refers to. Removing a video from the library deletes its copy; "New project" deletes
  all of them. A copy in progress is cancelled and its partial file deleted.
- The library card shows the state: saving (with %), saved in the app, or not saved and why.
- Picking a video that is already stored keeps the stored copy; picking one that is not stored
  renews its handle.
- `?vault=off` disables copies (tests of the relink path).

## Consequences

- Reopening the app (or the OS killing the tab) no longer needs any file selection; a pending
  export resumes directly.
- Videos use device storage twice until removed from the library. Browsers may still evict OPFS
  data under storage pressure if persistence is refused; the app then falls back to "select
  again".
- The copy streams from the original file, so a video whose access is lost before the copy
  finishes is not stored (reported on its card).
