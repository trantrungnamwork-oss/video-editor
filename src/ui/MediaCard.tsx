import type { MediaWarning } from '../media/probe';
import { itemName, itemSize, useMediaStore, type MediaItem } from '../state/mediaStore';
import { mediaSourceOf, useProjectStore } from '../state/projectStore';
import { audioCodecLabel, formatBytes, formatDuration, formatFps, videoCodecLabel } from './format';

const WARNING_LABELS: Record<Exclude<MediaWarning, 'video-undecodable'>, string> = {
  'audio-undecodable': "Audio can't be decoded on this device",
  'no-audio': 'No audio track',
  hdr: 'HDR',
  'variable-frame-rate': 'Variable frame rate',
};

const ERROR_LABELS = {
  'unsupported-format': 'Unsupported file format (supported: MP4, MOV, WebM, MKV, MPEG-TS).',
  'no-video-track': 'This file has no video track.',
  'read-failed': 'Could not read this file.',
} as const;

export function MediaCard({ item }: { item: MediaItem }) {
  const removeItem = useMediaStore((s) => s.remove);
  const addToTimeline = useProjectStore((s) => s.addMedia);
  const usedInTimeline = useProjectStore((s) =>
    s.history.present.clips.some((c) => c.mediaId === item.id),
  );
  const addable = item.status === 'ready' && item.info.canDecode;
  const name = itemName(item);
  const remove = () => {
    // Removing from the library also removes the media's clips (one undoable step).
    useProjectStore.getState().removeMedia(item.id);
    removeItem(item.id);
  };

  return (
    <li
      className="rounded-lg bg-neutral-900 p-3"
      data-testid="media-card"
      data-status={item.status}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={name}>
            {name}
          </p>
          <p className="text-sm text-neutral-400">{formatBytes(itemSize(item))}</p>
        </div>
        {addable && (
          <button
            type="button"
            onClick={() => addToTimeline(mediaSourceOf(item.id, item.info))}
            className="flex min-h-11 shrink-0 items-center rounded-lg bg-neutral-800 px-3 text-sm font-medium active:bg-neutral-700"
            aria-label={`Add ${name} to timeline`}
          >
            {usedInTimeline ? '+ Again' : '+ Add'}
          </button>
        )}
        <button
          type="button"
          onClick={remove}
          aria-label={`Remove ${name}`}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-xl text-neutral-400 active:bg-neutral-800"
        >
          ×
        </button>
      </div>

      {item.status === 'probing' && <p className="mt-2 text-sm text-neutral-400">Reading…</p>}

      {item.status === 'missing' && (
        <p className="mt-2 rounded bg-amber-950 p-2 text-sm text-amber-200">
          Select this video again to keep editing (the browser forgets picked files when the page
          reloads).
        </p>
      )}

      {item.status === 'error' && (
        <p className="mt-2 rounded bg-red-950 p-2 text-sm text-red-300" role="alert">
          {ERROR_LABELS[item.error.code]}{' '}
          <span className="text-red-400/70">{item.error.message}</span>
        </p>
      )}

      {item.status === 'ready' && <MediaDetails info={item.info} />}
      {item.status === 'ready' && item.vault && <VaultLine vault={item.vault} />}
    </li>
  );
}

function MediaDetails({ info }: { info: Extract<MediaItem, { status: 'ready' }>['info'] }) {
  const { video, audio } = info;
  const warnings = info.warnings.filter(
    (w): w is keyof typeof WARNING_LABELS => w !== 'video-undecodable',
  );

  return (
    <>
      {!info.canDecode && (
        <p className="mt-2 rounded bg-red-950 p-2 text-sm text-red-300" role="alert">
          This device can&apos;t decode {videoCodecLabel(video.codec)} video
          {video.codecString ? ` (${video.codecString})` : ''} at {video.codedWidth}×
          {video.codedHeight}. This clip can&apos;t be edited here.
        </p>
      )}

      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <Field label="Duration" value={formatDuration(info.durationSec)} />
        <Field label="Resolution" value={`${video.displayWidth}×${video.displayHeight}`} />
        <Field
          label="Frame rate"
          value={`${video.isVariableFrameRate ? '~' : ''}${formatFps(video.frameRate)} fps`}
        />
        <Field label="Video" value={videoCodecLabel(video.codec)} title={video.codecString} />
        <Field
          label="Audio"
          value={
            audio
              ? `${audioCodecLabel(audio.codec)} ${audio.sampleRate / 1000} kHz ${audio.channels}ch`
              : 'None'
          }
          title={audio?.codecString ?? null}
        />
        <Field label="Container" value={info.container} />
      </dl>

      {warnings.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {warnings.map((w) => (
            <li key={w} className="rounded bg-amber-950 px-2 py-0.5 text-xs text-amber-300">
              {WARNING_LABELS[w]}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Whether the app holds its own copy (reopens after a reload without selecting it again). */
function VaultLine({
  vault,
}: {
  vault: NonNullable<Extract<MediaItem, { status: 'ready' }>['vault']>;
}) {
  const text =
    vault.state === 'copying'
      ? `Saving a copy in the app… ${Math.round(vault.fraction * 100)}%`
      : vault.state === 'stored'
        ? '✓ Saved in the app (reopens without selecting it again)'
        : `Not saved in the app: ${vault.reason}. After reopening, select it again.`;
  return (
    <p
      className={`mt-2 text-xs ${vault.state === 'skipped' ? 'text-amber-300' : 'text-neutral-400'}`}
      data-testid="vault-state"
      data-state={vault.state}
    >
      {text}
    </p>
  );
}

function Field({ label, value, title }: { label: string; value: string; title?: string | null }) {
  return (
    <div>
      <dt className="text-neutral-500">{label}</dt>
      <dd {...(title ? { title } : {})}>{value}</dd>
    </div>
  );
}
