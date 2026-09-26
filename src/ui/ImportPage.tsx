import { useRef, useState } from 'react';
import { DEFAULT_TEST_CLIP, parseTestClipSpec } from '../media/testClip';
import { requestTestClip } from '../media/testClipClient';
import { useMediaStore } from '../state/mediaStore';
import { MediaCard } from './MediaCard';
import { PreviewPanel } from './preview/PreviewPanel';

export function ImportPage() {
  const items = useMediaStore((s) => s.items);
  const addFiles = useMediaStore((s) => s.addFiles);
  const select = useMediaStore((s) => s.select);
  const selected = useMediaStore((s) => s.items.find((it) => it.id === s.selectedId) ?? null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [testClip, setTestClip] = useState<'idle' | 'encoding' | string>('idle');

  const addTestClip = async () => {
    setTestClip('encoding');
    try {
      const spec =
        parseTestClipSpec(new URLSearchParams(location.search).get('testclip')) ??
        DEFAULT_TEST_CLIP;
      const [id] = addFiles([await requestTestClip(spec)]);
      if (id) select(id);
      setTestClip('idle');
    } catch (err) {
      setTestClip(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-4 px-4 py-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Video Editor</h1>
        <a href="/debug" className="flex min-h-11 items-center text-sm text-neutral-400">
          Device report
        </a>
      </header>

      {selected?.status === 'ready' && selected.info.canDecode ? (
        <PreviewPanel key={selected.id} file={selected.file} info={selected.info} />
      ) : (
        <p className="text-neutral-400">
          Everything runs on this device. Your videos are never uploaded.
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

      {items.length === 0 ? (
        <p className="py-12 text-center text-neutral-500">No clips yet.</p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="media-list">
          {items.map((item) => (
            <MediaCard key={item.id} item={item} selected={item.id === selected?.id} />
          ))}
        </ul>
      )}
    </main>
  );
}
