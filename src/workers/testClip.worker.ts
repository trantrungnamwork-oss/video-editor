import { generateTestClip, type TestClipSpec } from '../media/testClip';

self.onmessage = async (e: MessageEvent<TestClipSpec>) => {
  try {
    postMessage({ ok: true, file: await generateTestClip(e.data) });
  } catch (err) {
    postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
