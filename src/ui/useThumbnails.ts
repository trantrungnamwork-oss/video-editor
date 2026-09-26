import { useEffect, useState } from 'react';
import { requestThumbnails } from '../media/thumbnailClient';

export const THUMB_COUNT = 12;
export const THUMB_HEIGHT_CSS = 56;

// One strip per file for the whole session: split clips of the same media share it.
const cache = new WeakMap<File, Promise<string[]>>();

function load(file: File): Promise<string[]> {
  let p = cache.get(file);
  if (!p) {
    const height = Math.round(THUMB_HEIGHT_CSS * Math.min(window.devicePixelRatio || 1, 2));
    p = requestThumbnails(file, { count: THUMB_COUNT, height }).then((thumbs) => {
      const urls = new Map<Blob, string>();
      return thumbs.map((t) => {
        const url = urls.get(t.blob) ?? URL.createObjectURL(t.blob);
        urls.set(t.blob, url);
        return url;
      });
    });
    p.catch((err: unknown) => {
      cache.delete(file);
      console.warn('[thumbnails]', err);
    });
    cache.set(file, p);
  }
  return p;
}

/** Thumbnail URLs evenly covering the whole media (THUMB_COUNT slots). */
export function useThumbnails(file: File | undefined): string[] {
  const [state, setState] = useState<{ file: File; urls: string[] } | null>(null);
  useEffect(() => {
    if (!file) return;
    let alive = true;
    load(file).then(
      (urls) => alive && setState({ file, urls }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [file]);
  return state && state.file === file ? state.urls : [];
}
