import { describe, expect, it } from 'vitest';
import { MediaProbeError, type MediaInfo } from '../media/probe';
import type { ProbeClient } from '../media/probeClient';
import { createMediaStore } from './mediaStore';

function deferredClient() {
  const calls: { file: File; resolve: (i: MediaInfo) => void; reject: (e: Error) => void }[] = [];
  const client: ProbeClient = {
    probe: (file) => new Promise((resolve, reject) => calls.push({ file, resolve, reject })),
    dispose: () => undefined,
  };
  return { client, calls };
}

const file = (name: string) => new File([new Uint8Array(1)], name, { type: 'video/mp4' });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('mediaStore', () => {
  it('adds files as probing and settles each independently', async () => {
    const { client, calls } = deferredClient();
    const store = createMediaStore(() => client);
    store.getState().addFiles([file('a.mp4'), file('b.mov')]);
    expect(store.getState().items.map((i) => i.status)).toEqual(['probing', 'probing']);

    calls[1]?.reject(new MediaProbeError('unsupported-format', 'nope'));
    calls[0]?.resolve({ name: 'a.mp4' } as MediaInfo);
    await flush();

    const [a, b] = store.getState().items;
    expect(a?.status).toBe('ready');
    expect(b).toMatchObject({ status: 'error', error: { code: 'unsupported-format' } });
  });

  it('ignores results for items removed while probing', async () => {
    const { client, calls } = deferredClient();
    const store = createMediaStore(() => client);
    store.getState().addFiles([file('a.mp4')]);
    const id = store.getState().items[0]?.id ?? '';
    store.getState().remove(id);
    calls[0]?.resolve({ name: 'a.mp4' } as MediaInfo);
    await flush();
    expect(store.getState().items).toEqual([]);
  });
});
