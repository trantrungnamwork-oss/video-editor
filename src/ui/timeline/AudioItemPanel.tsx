import { duckOn, itemEnd } from '../../core/audioTrack';
import { DEFAULT_CLIP_AUDIO, projectDuration, type AudioItem } from '../../core/project';
import { useProjectStore } from '../../state/projectStore';
import { AudioControls } from './ClipAudioPanel';

const BTN =
  'flex min-h-11 items-center justify-center rounded-lg px-3 text-sm font-medium bg-neutral-800 active:bg-neutral-700';

/** Settings of the selected music or voice item: volume, fades, looping, ducking, delete. */
export function AudioItemPanel({ item }: { item: AudioItem }) {
  const project = useProjectStore((s) => s.history.present);
  const s = useProjectStore.getState;
  const length = itemEnd(item, projectDuration(project)) - item.startSec;
  return (
    <AudioControls
      id={item.id}
      saved={item.audio ?? DEFAULT_CLIP_AUDIO}
      lengthSec={length}
      onCommit={(audio) => s().setAudioSettings(item.id, audio)}
      testId="audio-item-panel"
    >
      <div className="flex flex-wrap gap-2 sm:col-span-4">
        {item.kind === 'music' && (
          <button
            type="button"
            className={BTN}
            aria-pressed={item.loop}
            onClick={() =>
              s().setAudioLength(item.id, {
                loop: !item.loop,
                durationSec: item.loop ? item.durationSec : null,
              })
            }
          >
            {item.loop ? '🔁 Repeat to the end: on' : '🔁 Repeat to the end: off'}
          </button>
        )}
        <button
          type="button"
          className={BTN}
          aria-pressed={duckOn(project)}
          onClick={() => s().setDuck(!duckOn(project))}
          title="Lower the music while a voice-over plays"
        >
          {duckOn(project) ? 'Lower music under voice: on' : 'Lower music under voice: off'}
        </button>
        <button
          type="button"
          className={`${BTN} text-red-300`}
          onClick={() => s().removeAudio(item.id)}
          aria-label={`Delete ${item.kind === 'music' ? 'music' : 'voice-over'}`}
        >
          Delete
        </button>
      </div>
    </AudioControls>
  );
}
