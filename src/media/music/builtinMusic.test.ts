import { describe, expect, it } from 'vitest';
import { BUILTIN_TRACKS, renderBuiltinWav } from './builtinMusic';

describe('built-in music', () => {
  it.each(BUILTIN_TRACKS.map((t) => [t.id, t.seconds] as const))(
    '%s renders a non-silent, unclipped stereo WAV loop of %ss',
    (id, seconds) => {
      const bytes = renderBuiltinWav(id, 8000);
      const view = new DataView(bytes.buffer);
      expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
      const frames = (bytes.length - 44) / 4;
      expect(frames).toBe(seconds * 8000);
      let peak = 0;
      for (let i = 0; i < frames; i += 7)
        peak = Math.max(peak, Math.abs(view.getInt16(44 + i * 4, true)));
      expect(peak / 32767).toBeGreaterThan(0.1);
      expect(peak / 32767).toBeLessThan(1);
      // Deterministic.
      expect(renderBuiltinWav(id, 8000)).toEqual(bytes);
    },
  );
});
