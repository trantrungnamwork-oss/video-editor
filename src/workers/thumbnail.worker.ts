import { generateThumbnails, ThumbnailCache, type ThumbnailRequest } from '../media/thumbnails';

interface Request extends ThumbnailRequest {
  id: number;
  file: File;
}

const cache = ThumbnailCache.open();
// One clip at a time: thumbnail decoding competes with preview playback for the decoder.
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (e: MessageEvent<Request>) => {
  const { id, file, count, height } = e.data;
  queue = queue.then(async () => {
    try {
      const thumbs = await generateThumbnails(file, { count, height }, await cache);
      postMessage({ id, ok: true, thumbs });
    } catch (err) {
      postMessage({ id, ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });
};
