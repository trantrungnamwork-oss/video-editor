import { ASPECTS, type AspectRatio, type Fit } from '../core/frame';
import { aspectOf, fitOf } from '../core/project';
import { useProjectStore } from '../state/projectStore';

const LABELS: Record<AspectRatio, string> = {
  source: 'Original',
  '16:9': '16:9',
  '9:16': '9:16',
  '1:1': '1:1',
  '4:5': '4:5',
};

const FITS: { fit: Fit; label: string }[] = [
  { fit: 'cover', label: 'Fill' },
  { fit: 'contain', label: 'Fit' },
];

const chip = (on: boolean) =>
  `min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium ${
    on ? 'bg-yellow-400 text-black' : 'bg-neutral-800 active:bg-neutral-700'
  }`;

/**
 * Frame shape and, for the whole project, whether clips fill the frame (cropped) or fit in it
 * (bars). A clip can still override the fit in its own panel.
 */
export function AspectPicker() {
  const aspect = useProjectStore((s) => aspectOf(s.history.present));
  const fit = useProjectStore((s) => fitOf(s.history.present));
  return (
    <div className="flex flex-wrap gap-2">
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
            className={chip(aspect === a)}
          >
            {LABELS[a]}
          </button>
        ))}
      </div>
      <div
        role="radiogroup"
        aria-label="All clips"
        className="flex gap-1"
        data-testid="project-fit"
      >
        {FITS.map((f) => (
          <button
            key={f.fit}
            type="button"
            role="radio"
            aria-checked={fit === f.fit}
            onClick={() => useProjectStore.getState().setProjectFit(f.fit)}
            className={chip(fit === f.fit)}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}
