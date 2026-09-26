import { describe, expect, it } from 'vitest';
import type { MediaInfo } from '../media/probe';
import type { ProbeClient } from '../media/probeClient';
import { createMediaStore } from './mediaStore';
import { autoAddImportedMedia, createProjectStore } from './projectStore';

const flush = () => new Promise((r) => setTimeout(r, 0));
const info = (durationSec: number, canDecode = true) =>
  ({ durationSec, canDecode, video: { frameRate: 30 } }) as MediaInfo;

describe('projectStore', () => {
  it('records edits as undoable steps and keeps selection valid', () => {
    const store = createProjectStore();
    const s = () => store.getState();
    s().addMedia({ id: 'm', durationSec: 10, frameRate: 30 });
    const clipId = s().history.present.clips[0]?.id ?? '';
    s().select(clipId);
    s().split(4);
    expect(s().history.present.clips).toHaveLength(2);
    s().removeClip(clipId);
    expect(s().selectedClipId).toBeNull();
    s().undo();
    expect(s().history.present.clips).toHaveLength(2);
    s().undo();
    s().undo();
    expect(s().history.present.clips).toHaveLength(0);
    s().redo();
    expect(s().history.present.clips).toHaveLength(1);
  });

  it('does not record no-op edits', () => {
    const store = createProjectStore();
    store.getState().addMedia({ id: 'm', durationSec: 10, frameRate: 30 });
    const before = store.getState().history;
    store.getState().split(0.01);
    expect(store.getState().history).toBe(before);
  });

  it('adds decodable imports to the timeline once, in import order', async () => {
    const pending: ((i: MediaInfo) => void)[] = [];
    const client: ProbeClient = {
      probe: () => new Promise((resolve) => pending.push(resolve)),
      dispose: () => undefined,
    };
    const media = createMediaStore(() => client);
    const project = createProjectStore();
    const stop = autoAddImportedMedia(media, project);

    const file = (n: string) => new File([new Uint8Array(1)], n);
    media.getState().addFiles([file('a'), file('b'), file('c')]);
    pending[0]?.(info(3));
    pending[1]?.(info(2, false)); // undecodable: stays out of the timeline
    pending[2]?.(info(5));
    await flush();

    const clips = project.getState().history.present.clips;
    const ids = media.getState().items.map((i) => i.id);
    expect(clips.map((c) => c.mediaId)).toEqual([ids[0], ids[2]]);

    project.getState().removeMedia(ids[0] ?? '');
    media.setState({ items: [...media.getState().items] }); // any later store update
    expect(project.getState().history.present.clips.map((c) => c.mediaId)).toEqual([ids[2]]);
    stop();
  });
});
