import { useRef } from 'react';
import { useMediaStore } from '../state/mediaStore';
import { MediaCard } from './MediaCard';

export function ImportPage() {
  const items = useMediaStore((s) => s.items);
  const addFiles = useMediaStore((s) => s.addFiles);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-4 px-4 py-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Video Editor</h1>
        <a href="/debug" className="flex min-h-11 items-center text-sm text-neutral-400">
          Device report
        </a>
      </header>

      <p className="text-neutral-400">
        Everything runs on this device. Your videos are never uploaded.
      </p>

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="min-h-12 rounded-lg bg-green-600 px-4 text-lg font-medium text-white active:bg-green-700"
      >
        Import videos
      </button>
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
            <MediaCard key={item.id} item={item} />
          ))}
        </ul>
      )}
    </main>
  );
}
