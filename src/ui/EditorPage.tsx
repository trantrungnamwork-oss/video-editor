import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CopyClip } from '../media/export/copyExport';
import { checkpointMix, type Checkpoint } from '../media/export/exportPipeline';
import { discardPendingExport, readPendingCheckpoint } from '../media/export/opfsFile';
import { identityOf, jobKey } from '../media/export/segments';
import type { PreviewPlayer } from '../media/preview/previewPlayer';
import type { SequenceClip } from '../media/preview/sequence';
import { DEFAULT_TEST_CLIP, parseTestClipSpec } from '../media/testClip';
import { requestTestClip } from '../media/testClipClient';
import { audioItemsOf, duckOn } from '../core/audioTrack';
import { frameSize } from '../core/frame';
import type { AudioMix } from '../media/audioMix';
import { aspectOf, EMPTY_PROJECT, layoutOf } from '../core/project';
import { useMediaStore } from '../state/mediaStore';
import { persistChanges } from '../state/persistence';
import { autoAddImportedMedia, useProjectStore } from '../state/projectStore';
import { AspectPicker } from './AspectPicker';
import { AudioButtons } from './AudioButtons';
import { ExportDialog } from './export/ExportDialog';
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
  const testClipCount = useRef(0);
  const [exporting, setExporting] = useState<false | 'new' | 'resume'>(false);
  const [pending, setPending] = useState<Checkpoint | null>(null);

  useEffect(() => {
    const offAuto = autoAddImportedMedia();
    const offPersist = persistChanges();
    return () => {
      offAuto();
      offPersist();
    };
  }, []);

  const refreshPending = useCallback(() => {
    void readPendingCheckpoint().then(setPending);
  }, []);
  useEffect(refreshPending, [refreshPending]);

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
          frameRate: it.info.video?.frameRate ?? null,
          hasAudio: it.info.audio?.decode.status === 'supported',
          audio: c.audio,
          layout: layoutOf(project, c),
        };
      }),
    [project, readyById],
  );

  // Output frame: the project's aspect ratio around the first clip's display size.
  const first = sequence[0]
    ? (readyById.get(sequence[0].mediaId)?.info.video ?? undefined)
    : undefined;
  const frame = first
    ? frameSize(aspectOf(project), first.displayWidth, first.displayHeight)
    : null;
  // Copying the streams keeps the source frame; a reshaped frame must be re-encoded.
  const copyBlocked =
    first && frame && (frame.width !== first.displayWidth || frame.height !== first.displayHeight)
      ? 'The frame shape was changed, which needs re-encoding'
      : null;
  const missingCount = items.filter((it) => it.status === 'missing').length;
  // Export needs every clip's file; after a reload some may still be waiting for relink.
  // Music and voice-over with their files (items whose file is still missing wait for relink).
  const mix = useMemo<AudioMix>(() => {
    const audioItems = audioItemsOf(project).flatMap((a) => {
      const it = readyById.get(a.mediaId);
      return it ? [{ ...a, file: it.file }] : [];
    });
    return { audioItems, duck: duckOn(project) };
  }, [project, readyById]);
  const complete =
    project.clips.length > 0 &&
    sequence.length === project.clips.length &&
    mix.audioItems.length === audioItemsOf(project).length;

  const exportClips = useMemo<CopyClip[]>(
    () =>
      sequence.map(({ id, mediaId, file, inSec, outSec, hasAudio, audio, layout }) => ({
        clipId: id,
        mediaId,
        file,
        inSec,
        outSec,
        hasAudio,
        ...(audio ? { audio } : {}),
        ...(layout ? { layout } : {}),
      })),
    [sequence],
  );
  const resumable =
    pending !== null &&
    complete &&
    jobKey({
      ...pending.settings,
      clips: exportClips.map((c) => ({ ...c, file: identityOf(c.file) })),
      mix: checkpointMix(mix),
    }) === pending.key;

  /** Clears the timeline, the library and any unfinished export (after a confirmation). */
  const startNewProject = () => {
    if (!confirm('Start a new project? The current timeline and library will be cleared.')) return;
    useProjectStore.getState().restore(EMPTY_PROJECT);
    useMediaStore.getState().clear();
    void discardPendingExport().then(refreshPending);
  };

  const addTestClip = async () => {
    setTestClip('encoding');
    try {
      // `?testclip=A,B,…` cycles through specs, one per added clip (mixed formats in tests).
      const specs = (new URLSearchParams(location.search).get('testclip') ?? '').split(',');
      const spec =
        parseTestClipSpec(specs[testClipCount.current++ % specs.length] ?? null) ??
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
        <div className="flex items-center gap-3">
          <a href="/debug" className="flex min-h-11 items-center text-sm text-neutral-400">
            Device report
          </a>
          <button
            type="button"
            disabled={!first || !complete}
            onClick={() => {
              player?.pause(); // free the decoder for the export
              setExporting('new');
            }}
            className="min-h-11 rounded-lg bg-green-600 px-4 font-medium text-white active:bg-green-700 disabled:opacity-40"
            data-testid="open-export"
          >
            Export
          </button>
        </div>
      </header>
      {exporting && first && frame && (
        <ExportDialog
          clips={exportClips}
          mix={mix}
          durationSec={sequence.reduce((d, c) => d + c.outSec - c.inSec, 0)}
          sourceWidth={frame.width}
          sourceHeight={frame.height}
          fps={first.frameRate ?? 30}
          copyBlocked={copyBlocked}
          resumeFrom={exporting === 'resume' ? pending : null}
          onSnapCuts={(snaps) => useProjectStore.getState().setCuts(snaps)}
          onClose={() => {
            setExporting(false);
            refreshPending();
          }}
        />
      )}

      {missingCount > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-950 p-3 text-sm text-amber-200"
          data-testid="missing-banner"
        >
          <span className="flex-1">
            {missingCount} video{missingCount > 1 ? 's' : ''} from your saved project need
            {missingCount > 1 ? '' : 's'} to be selected again.
          </span>
          <button
            type="button"
            className="min-h-11 rounded-lg bg-amber-600 px-3 font-medium text-black"
            onClick={() => inputRef.current?.click()}
          >
            Select videos
          </button>
          <button
            type="button"
            className="min-h-11 rounded-lg bg-neutral-800 px-3 font-medium text-neutral-100"
            onClick={startNewProject}
            data-testid="new-project"
          >
            Start new
          </button>
        </div>
      )}

      {pending && !exporting && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg bg-neutral-800 p-3 text-sm"
          data-testid="resume-banner"
        >
          <span className="flex-1">
            Unfinished export (
            {Math.round((100 * pending.segmentsDone) / Math.max(1, pending.segmentCount))}% of video
            done).
            {!complete && ' Select the missing videos to resume it.'}
            {complete && !resumable && ' The timeline changed since, so it cannot be resumed.'}
          </span>
          <button
            type="button"
            className="min-h-11 rounded-lg bg-neutral-700 px-3"
            onClick={() => void discardPendingExport().then(refreshPending)}
          >
            Discard
          </button>
          <button
            type="button"
            className="min-h-11 rounded-lg bg-green-600 px-3 font-medium text-white disabled:opacity-40"
            disabled={!resumable}
            onClick={() => {
              player?.pause();
              setExporting('resume');
            }}
            data-testid="resume-export"
          >
            Resume
          </button>
        </div>
      )}

      {project.clips.length > 0 ? (
        <>
          {frame && complete ? (
            <>
              <PreviewPanel
                clips={sequence}
                mix={mix}
                width={frame.width}
                height={frame.height}
                onPlayer={setPlayer}
              />
              <AspectPicker />
              <AudioButtons player={player} />
            </>
          ) : (
            <p className="rounded-lg bg-neutral-900 p-6 text-center text-neutral-400">
              Preview is available once all videos of the project are selected again.
            </p>
          )}
          <Timeline player={complete ? player : null} project={project} files={files} />
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
      {(project.clips.length > 0 || items.length > 0) && missingCount === 0 && (
        <button
          type="button"
          onClick={startNewProject}
          data-testid="new-project"
          className="min-h-11 self-start rounded-lg px-3 text-sm text-neutral-400 active:bg-neutral-800"
        >
          New project
        </button>
      )}
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
