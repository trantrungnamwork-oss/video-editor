import { useEffect } from 'react';
import type { PreviewPlayer } from '../../media/preview/previewPlayer';

/**
 * Calls `onFrame(time)` every animation frame. Used to move the playhead and time readout by
 * writing to DOM refs directly, so playback never re-renders React at 60 fps.
 */
export function usePlayhead(player: PreviewPlayer, onFrame: (t: number) => void) {
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const loop = () => {
      const t = player.currentTime;
      if (t !== last) {
        last = t;
        onFrame(t);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [player, onFrame]);
}
