import { describe, expect, it, vi } from 'vitest';
import type { MediaInfo } from '../media/probe';
import type { ProbeClient } from '../media/probeClient';
import type { StoreResult, VaultClient } from '../media/vault/vault';
import { createMediaStore } from './mediaStore';

const info = { durationSec: 3, canDecode: true } as MediaInfo;
const client: ProbeClient = { probe: () => Promise.resolve(info), dispose: () => undefined };
const tick = () => new Promise((r) => setTimeout(r, 0));
const video = () => new File([new Uint8Array(3)], 'a.mp4', { lastModified: 42 });

function fakeVault(result: (file: File) => StoreResult) {
  const vault: VaultClient = {
    store: vi.fn((_id: string, file: File, onProgress: (f: number) => void) => {
      onProgress(0.5);
      return Promise.resolve(result(file));
    }),
    remove: vi.fn(() => Promise.resolve()),
    load: vi.fn(() => Promise.resolve(null)),
    prune: vi.fn(() => Promise.resolve()),
  };
  return vault;
}

describe('mediaStore with the OPFS vault', () => {
  it('switches a usable video to its stored copy', async () => {
    const copy = video();
    const vault = fakeVault(() => ({ stored: copy }));
    const store = createMediaStore(
      () => client,
      () => vault,
    );
    const [id] = store.getState().addFiles([video()]);
    await tick();
    await tick();
    const it0 = store.getState().items[0];
    expect(it0).toMatchObject({ id, status: 'ready', vault: { state: 'stored' } });
    expect(it0?.status === 'ready' && it0.file).toBe(copy);

    // Picking the same video again keeps the stored copy.
    store.getState().addFiles([video()]);
    const it1 = store.getState().items[0];
    expect(it1?.status === 'ready' && it1.file).toBe(copy);
  });

  it('keeps the picked file and says why when the copy is skipped', async () => {
    const vault = fakeVault(() => ({ skipped: 'Not enough free storage on this device' }));
    const store = createMediaStore(
      () => client,
      () => vault,
    );
    const original = video();
    store.getState().addFiles([original]);
    await tick();
    await tick();
    const item = store.getState().items[0];
    expect(item).toMatchObject({
      status: 'ready',
      vault: { state: 'skipped', reason: 'Not enough free storage on this device' },
    });
    expect(item?.status === 'ready' && item.file).toBe(original);
  });

  it('does not copy videos this device cannot decode', async () => {
    const vault = fakeVault(() => ({ skipped: 'x' }));
    const undecodable: ProbeClient = {
      probe: () => Promise.resolve({ ...info, canDecode: false }),
      dispose: () => undefined,
    };
    const store = createMediaStore(
      () => undecodable,
      () => vault,
    );
    store.getState().addFiles([video()]);
    await tick();
    expect(vault.store).not.toHaveBeenCalled();
  });

  it('deletes copies when videos are removed or the library is cleared', async () => {
    const vault = fakeVault((f) => ({ stored: f }));
    const store = createMediaStore(
      () => client,
      () => vault,
    );
    const [a] = store.getState().addFiles([video()]);
    await tick();
    store.getState().remove(a ?? '');
    expect(vault.remove).toHaveBeenCalledWith(a);

    const [b] = store.getState().addFiles([video()]);
    await tick();
    store.getState().clear();
    expect(store.getState().items).toEqual([]);
    expect(vault.remove).toHaveBeenCalledWith(b);
    await tick();
    expect(vault.prune).toHaveBeenCalledWith(new Set());
  });
});
