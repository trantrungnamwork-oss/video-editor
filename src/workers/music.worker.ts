/// <reference lib="webworker" />
/** Renders built-in music off the main thread (a 16 s track is ~1.4 M samples). */
import { renderBuiltinWav } from '../media/music/builtinMusic';

self.onmessage = (e: MessageEvent<{ id: string }>) => {
  try {
    const bytes = renderBuiltinWav(e.data.id);
    self.postMessage({ ok: true, bytes }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
