import { describe, expect, it } from 'vitest';
import type { MediaInfo } from '../media/probe';
import type { ProbeClient } from '../media/probeClient';
import { createMediaStore } from './mediaStore';

const info = { durationSec: 3 } as MediaInfo;

describe('mediaStore relink', () => {
  it('relinks a re-selected file to its missing item and keeps the id', async () => {
    const client: ProbeClient = { probe: () => Promise.resolve(info), dispose: () => undefined };
    const store = createMediaStore(() => client);
    store
      .getState()
      .restoreMissing([
        { id: 'keep-me', identity: { name: 'a.mp4', size: 3, lastModified: 42 }, info },
      ]);

    const same = new File([new Uint8Array(3)], 'a.mp4', { lastModified: 42 });
    const other = new File([new Uint8Array(3)], 'a.mp4', { lastModified: 43 });
    const ids = store.getState().addFiles([same, other]);

    expect(ids[0]).toBe('keep-me');
    expect(ids[1]).not.toBe('keep-me');
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().items.map((i) => [i.id === 'keep-me', i.status])).toEqual([
      [true, 'ready'],
      [false, 'ready'],
    ]);
  });

  it('renews the handle of a ready item when the same file is picked again', async () => {
    const client: ProbeClient = { probe: () => Promise.resolve(info), dispose: () => undefined };
    const store = createMediaStore(() => client);
    const first = new File([new Uint8Array(3)], 'a.mp4', { lastModified: 42 });
    const [id] = store.getState().addFiles([first]);
    await new Promise((r) => setTimeout(r, 0));

    const again = new File([new Uint8Array(3)], 'a.mp4', { lastModified: 42 });
    expect(store.getState().addFiles([again])).toEqual([id]);
    const items = store.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, status: 'ready' });
    expect(items[0]?.status === 'ready' && items[0].file).toBe(again);
  });
});
