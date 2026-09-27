import { MediaProbeError, probeMedia } from '../media/probe';
import type { ProbeRequest, ProbeResponse } from '../media/probeClient';

// Probes run one at a time: each holds a demuxer cache, and a batch import from the photo
// library can queue dozens of files.
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (e: MessageEvent<ProbeRequest>) => {
  const { id, file } = e.data;
  queue = queue.then(async () => {
    let response: ProbeResponse;
    try {
      response = { id, ok: true, info: await probeMedia(file, file.name) };
    } catch (err) {
      const error =
        err instanceof MediaProbeError
          ? { code: err.code, message: err.message }
          : { code: 'read-failed' as const, message: String(err) };
      response = { id, ok: false, error };
    }
    postMessage(response);
  });
};
