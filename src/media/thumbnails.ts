/**
 * Thumbnail strip generation (runs in thumbnail.worker.ts) with an OPFS cache.
 *
 * Each thumbnail snaps to the keyframe at or before its slot, so producing one costs a single
 * decode instead of decoding up to a whole GOP. Slots that share a keyframe share an image.
 */
import { BlobSource, CanvasSink, EncodedPacketSink, Input } from 'mediabunny';
import { SUPPORTED_INPUT_FORMATS } from './probe';

export interface ThumbnailRequest {
  count: number;
  /** Thumbnail height in pixels (width follows the display aspect ratio). */
  height: number;
}

export interface Thumbnail {
  /** Timestamp of the decoded (key)frame. */
  timestamp: number;
  blob: Blob;
}

const CACHE_VERSION = 1;
const CACHE_DIR = 'thumbnails';
const JPEG_QUALITY = 0.7;

/** Evenly spaced slot centres across the clip. */
export function thumbnailSlots(durationSec: number, count: number): number[] {
  if (count <= 0 || !(durationSec > 0)) return [];
  return Array.from({ length: count }, (_, i) => ((i + 0.5) * durationSec) / count);
}

export async function generateThumbnails(
  file: File,
  req: ThumbnailRequest,
  cache: ThumbnailCache | null = null,
): Promise<Thumbnail[]> {
  const key = await cacheKey(file, req);
  const cached = await cache?.read(key).catch(() => null);
  if (cached) return cached;

  const input = new Input({ source: new BlobSource(file), formats: SUPPORTED_INPUT_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return [];
    const [duration, displayWidth, displayHeight] = await Promise.all([
      input.computeDuration(),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
    ]);

    const keySink = new EncodedPacketSink(track);
    const slotKeys: number[] = [];
    for (const t of thumbnailSlots(duration, req.count)) {
      const key = await keySink.getKeyPacket(t, { metadataOnly: true });
      slotKeys.push(key?.timestamp ?? t);
    }
    const unique = [...new Set(slotKeys)].sort((a, b) => a - b);

    const height = Math.round(req.height);
    const width = Math.max(1, Math.round((height * displayWidth) / displayHeight));
    const sink = new CanvasSink(track, { width, height, fit: 'fill', poolSize: 1 });
    const blobs = new Map<number, Thumbnail>();
    let i = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(unique)) {
      const requested = unique[i++];
      if (!wrapped || requested === undefined) continue;
      const blob = await toJpeg(wrapped.canvas);
      blobs.set(requested, { timestamp: wrapped.timestamp, blob });
    }

    const thumbs = slotKeys.flatMap((k) => blobs.get(k) ?? []);
    await cache?.write(key, thumbs).catch(() => undefined);
    return thumbs;
  } finally {
    input.dispose();
  }
}

async function toJpeg(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      JPEG_QUALITY,
    ),
  );
}

async function cacheKey(file: File, req: ThumbnailRequest): Promise<string> {
  const id = [CACHE_VERSION, file.name, file.size, file.lastModified, req.count, req.height].join(
    '|',
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Manifest {
  version: number;
  timestamps: number[];
  /** Index into the stored image files for each thumbnail (duplicates share a file). */
  files: number[];
}

/** Stores thumbnails as `thumbnails/<key>/<n>.jpg` plus a manifest written last (commit marker). */
export class ThumbnailCache {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  static async open(): Promise<ThumbnailCache | null> {
    try {
      const root = await navigator.storage.getDirectory();
      return new ThumbnailCache(await root.getDirectoryHandle(CACHE_DIR, { create: true }));
    } catch {
      return null;
    }
  }

  async read(key: string): Promise<Thumbnail[] | null> {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await this.root.getDirectoryHandle(key);
    } catch {
      return null;
    }
    const manifestFile = await (await dir.getFileHandle('manifest.json')).getFile();
    const manifest = JSON.parse(await manifestFile.text()) as Manifest;
    if (manifest.version !== CACHE_VERSION) return null;
    const blobs = new Map<number, Blob>();
    for (const n of new Set(manifest.files)) {
      blobs.set(n, await (await dir.getFileHandle(`${n}.jpg`)).getFile());
    }
    const thumbs: Thumbnail[] = [];
    for (const [i, n] of manifest.files.entries()) {
      const blob = blobs.get(n);
      const timestamp = manifest.timestamps[i];
      if (!blob || timestamp === undefined) return null;
      thumbs.push({ timestamp, blob });
    }
    return thumbs;
  }

  async write(key: string, thumbs: Thumbnail[]): Promise<void> {
    const dir = await this.root.getDirectoryHandle(key, { create: true });
    const index = new Map<Blob, number>();
    const files = thumbs.map((t) => {
      const n = index.get(t.blob) ?? index.size;
      index.set(t.blob, n);
      return n;
    });
    for (const [blob, n] of index) await writeFile(dir, `${n}.jpg`, blob);
    const manifest: Manifest = {
      version: CACHE_VERSION,
      timestamps: thumbs.map((t) => t.timestamp),
      files,
    };
    await writeFile(dir, 'manifest.json', new Blob([JSON.stringify(manifest)]));
  }
}

interface SyncHandle {
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, blob: Blob) {
  const handle = (await dir.getFileHandle(name, { create: true })) as FileSystemFileHandle & {
    createSyncAccessHandle?: () => Promise<SyncHandle>;
  };
  // Sync access handles exist only in workers but are the most widely supported write path
  // (older Safari lacks createWritable).
  if (typeof handle.createSyncAccessHandle === 'function') {
    const sync = await handle.createSyncAccessHandle();
    try {
      sync.truncate(0);
      sync.write(new Uint8Array(await blob.arrayBuffer()), { at: 0 });
      sync.flush();
    } finally {
      sync.close();
    }
    return;
  }
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}
