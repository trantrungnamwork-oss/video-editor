import { useEffect, useState } from 'react';

export type WakeLockState = 'unsupported' | 'active' | 'released';

/**
 * Keeps the screen on while `enabled`. The browser drops the lock whenever the page is hidden, so
 * it is re-acquired when the page becomes visible again.
 */
export function useWakeLock(enabled: boolean): WakeLockState {
  const [state, setState] = useState<WakeLockState>(() =>
    'wakeLock' in navigator ? 'released' : 'unsupported',
  );

  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let alive = true;
    const acquire = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        sentinel = await navigator.wakeLock.request('screen');
        if (!alive) return void sentinel.release();
        setState('active');
        sentinel.addEventListener('release', () => alive && setState('released'));
      } catch {
        setState('released');
      }
    };
    const onVisible = () => void acquire();
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release();
    };
  }, [enabled]);

  return enabled ? state : state === 'unsupported' ? 'unsupported' : 'released';
}
