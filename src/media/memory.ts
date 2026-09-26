/**
 * Peak memory sampling for benchmarks.
 *
 * `performance.measureUserAgentSpecificMemory()` (Chromium, cross-origin isolated pages only)
 * reports the page's JS/wasm heaps and DOM, including dedicated workers. It does NOT include
 * codec and GPU buffers, which live in other browser processes. Safari/Firefox expose nothing
 * (TL-003), so results say which method was used, or that none was available.
 */
export type MemoryMethod = 'measureUserAgentSpecificMemory' | 'performance.memory' | 'unavailable';

interface UASpecificMemory {
  bytes: number;
}

type PerformanceWithMemory = Performance & {
  measureUserAgentSpecificMemory?: () => Promise<UASpecificMemory>;
  memory?: { usedJSHeapSize: number };
};

export function memoryMethod(): MemoryMethod {
  const p = performance as PerformanceWithMemory;
  if (typeof p.measureUserAgentSpecificMemory === 'function' && globalThis.crossOriginIsolated) {
    return 'measureUserAgentSpecificMemory';
  }
  if (p.memory) return 'performance.memory';
  return 'unavailable';
}

async function sample(method: MemoryMethod): Promise<number | null> {
  const p = performance as PerformanceWithMemory;
  if (method === 'measureUserAgentSpecificMemory' && p.measureUserAgentSpecificMemory) {
    return (await p.measureUserAgentSpecificMemory()).bytes;
  }
  if (method === 'performance.memory' && p.memory) return p.memory.usedJSHeapSize;
  return null;
}

/** Samples memory until stopped; resolves with the peak (bytes) or null when unmeasurable. */
export function startPeakMemory(intervalMs = 1000): {
  stop(): Promise<number | null>;
  readonly method: MemoryMethod;
} {
  let method = memoryMethod();
  let peak: number | null = null;
  let running = true;
  let inFlight: Promise<void> = Promise.resolve();
  const measure = async () => {
    try {
      const b = await sample(method);
      if (b !== null) peak = Math.max(peak ?? 0, b);
    } catch {
      // Some builds (e.g. headless Chromium) refuse the precise API even when isolated.
      method = (performance as PerformanceWithMemory).memory ? 'performance.memory' : 'unavailable';
      if (method !== 'unavailable') await measure();
    }
  };
  const tick = () => {
    if (!running || method === 'unavailable') return;
    // One measurement at a time: measureUserAgentSpecificMemory can take seconds.
    inFlight = measure();
    void inFlight.then(() => running && setTimeout(tick, intervalMs));
  };
  tick();
  return {
    get method() {
      return method;
    },
    async stop() {
      running = false;
      await inFlight;
      await measure(); // one final sample right at the end
      return peak;
    },
  };
}
