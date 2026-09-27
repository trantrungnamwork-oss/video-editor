import { ASPECTS, type AspectRatio } from '../core/frame';
import { aspectOf } from '../core/project';
import { useProjectStore } from '../state/projectStore';

const LABELS: Record<AspectRatio, string> = {
  source: 'Original',
  '16:9': '16:9',
  '9:16': '9:16',
  '1:1': '1:1',
  '4:5': '4:5',
};

/** Output frame shape for the whole project. */
export function AspectPicker() {
  const aspect = useProjectStore((s) => aspectOf(s.history.present));
  return (
    <div
      role="radiogroup"
      aria-label="Frame shape"
      className="flex gap-1 overflow-x-auto"
      data-testid="aspect-picker"
    >
      {ASPECTS.map((a) => (
        <button
          key={a}
          type="button"
          role="radio"
          aria-checked={aspect === a}
          onClick={() => useProjectStore.getState().setAspect(a)}
          className={`min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium ${
            aspect === a ? 'bg-yellow-400 text-black' : 'bg-neutral-800 active:bg-neutral-700'
          }`}
        >
          {LABELS[a]}
        </button>
      ))}
    </div>
  );
}
