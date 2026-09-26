import { useEffect, useMemo, useRef, useState } from 'react';
import type { PreviewPlayer } from '../media/preview/previewPlayer';
import type { SequenceClip } from '../media/preview/sequence';
import { DEFAULT_TEST_CLIP, parseTestClipSpec } from '../media/testClip';
import { requestTestClip } from '../media/testClipClient';
import { useMediaStore } from '../state/mediaStore';
import { autoAddImportedMedia, useProjectStore } from '../state/projectStore';
import { MediaCard } from './MediaCard';
import { PreviewPanel } from './preview/PreviewPanel';
import { Timeline } from './timeline/Timeline';

export function EditorPage() {
  const items = useMediaStore((s) => s.items);
  const addFiles = useMediaStore((s) => s.addFiles);
  const project = useProjectStore((s) => s.history.present);
  const inputRef = useRef<HTMLInputElement>(null);
  const [player, setPlayer] = useState<PreviewPlayer | null>(null);
  const [testClip, setTestClip] = useState<'idle' | 'encoding' | string>('idle');

  useEffect(() => autoAddImportedMedia(), []);

  const readyById = useMemo(() => {
    const m = new Map<string, Extract<(typeof items)[number], { status: 'ready' }>>();
    for (const it of items) if (it.status === 'ready') m.set(it.id, it);
    return m;
  }, [items]);

  const files = useMemo(
    () => new Map([...readyById].map(([id, it]) => [id, it.file] as const)),
    [readyById],
  );

  const sequence = useMemo<SequenceClip[]>(
    () =>
      project.clips.flatMap((c) => {
        const it = readyById.get(c.mediaId);
        if (!it) return [];
        return {
          id: c.id,
          mediaId: c.mediaId,
          file: it.file,
          inSec: c.inSec,
          outSec: c.outSec,
          frameRate: it.info.video.frameRate,
          hasAudio: it.info.audio?.decode.status === 'supported',
        };
      }),
    [project, readyById],
  );

  // Output frame follows the first clip's display size (letterboxing the others).
  const first = sequence[0] ? readyById.get(sequence[0].mediaId)?.info.video : undefined;

  const addTestClip = async () => {
    setTestClip('encoding');
    try {
      const spec =
        parseTestClipSpec(new URLSearchParams(location.search).get('testclip')) ??
        DEFAULT_TEST_CLIP;
      addFiles([await requestTestClip(spec)]);
      setTestClip('idle');
    } catch (err) {
      setTestClip(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-3 px-4 py-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Video Editor</h1>
        <a href="/debug" className="flex min-h-11 items-center text-sm text-neutral-400">
          Device report
        </a>
      </header>

      {first ? (
        <>
          <PreviewPanel
            clips={sequence}
            width={first.displayWidth}
            height={first.displayHeight}
            onPlayer={setPlayer}
          />
          <Timeline player={player} project={project} files={files} />
        </>
      ) : (
        <p className="text-neutral-400">
          Import videos to start editing. Everything runs on this device; your videos are never
          uploaded.
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="min-h-12 flex-1 rounded-lg bg-green-600 px-4 text-lg font-medium text-white active:bg-green-700"
        >
          Import videos
        </button>
        <button
          type="button"
          onClick={() => void addTestClip()}
          disabled={testClip === 'encoding'}
          data-testid="add-test-clip"
          className="min-h-12 rounded-lg bg-neutral-800 px-4 text-sm font-medium active:bg-neutral-700 disabled:opacity-50"
        >
          {testClip === 'encoding' ? 'Encoding…' : 'Add test clip'}
        </button>
      </div>
      {testClip !== 'idle' && testClip !== 'encoding' && (
        <p className="rounded bg-red-950 p-2 text-sm text-red-300" role="alert">
          Test clip failed: {testClip}
        </p>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        multiple
        hidden
        data-testid="file-input"
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          // Allow re-selecting the same file.
          e.target.value = '';
        }}
      />

      {items.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-neutral-400">Library</h2>
          <ul className="flex flex-col gap-3" data-testid="media-list">
            {items.map((item) => (
              <MediaCard key={item.id} item={item} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
