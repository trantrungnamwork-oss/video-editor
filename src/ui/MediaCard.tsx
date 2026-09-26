import type { MediaWarning } from '../media/probe';
import { useMediaStore, type MediaItem } from '../state/mediaStore';
import { audioCodecLabel, formatBytes, formatDuration, formatFps, videoCodecLabel } from './format';

const WARNING_LABELS: Record<Exclude<MediaWarning, 'video-undecodable'>, string> = {
  'audio-undecodable': "Audio can't be decoded on this device",
  'no-audio': 'No audio track',
  hdr: 'HDR',
  'variable-frame-rate': 'Variable frame rate',
};

const ERROR_LABELS = {
  'unsupported-format': 'Unsupported file format.',
  'no-video-track': 'This file has no video track.',
  'read-failed': 'Could not read this file.',
} as const;

export function MediaCard({ item, selected }: { item: MediaItem; selected: boolean }) {
  const remove = useMediaStore((s) => s.remove);
  const select = useMediaStore((s) => s.select);
  const previewable = item.status === 'ready' && item.info.canDecode;

  return (
    <li
      className={`rounded-lg bg-neutral-900 p-3 ${selected ? 'ring-2 ring-green-500' : ''}`}
      data-testid="media-card"
      data-status={item.status}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={item.file.name}>
            {item.file.name}
          </p>
          <p className="text-sm text-neutral-400">{formatBytes(item.file.size)}</p>
        </div>
        {previewable && !selected && (
          <button
            type="button"
            onClick={() => select(item.id)}
            className="flex min-h-11 shrink-0 items-center rounded-lg bg-neutral-800 px-3 text-sm font-medium active:bg-neutral-700"
          >
            Preview
          </button>
        )}
        <button
          type="button"
          onClick={() => remove(item.id)}
          aria-label={`Remove ${item.file.name}`}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-xl text-neutral-400 active:bg-neutral-800"
        >
          ×
        </button>
      </div>

      {item.status === 'probing' && <p className="mt-2 text-sm text-neutral-400">Reading…</p>}

      {item.status === 'error' && (
        <p className="mt-2 rounded bg-red-950 p-2 text-sm text-red-300" role="alert">
          {ERROR_LABELS[item.error.code]}{' '}
          <span className="text-red-400/70">{item.error.message}</span>
        </p>
      )}

      {item.status === 'ready' && <MediaDetails info={item.info} />}
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

function Field({ label, value, title }: { label: string; value: string; title?: string | null }) {
  return (
    <div>
      <dt className="text-neutral-500">{label}</dt>
      <dd {...(title ? { title } : {})}>{value}</dd>
    </div>
  );
}
