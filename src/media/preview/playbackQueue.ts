import type { Closable } from './frameTracker';

export interface TimedFrame extends Closable {
  /** Presentation timestamp in seconds. */
  timestamp: number;
}

/** Slack for float noise when comparing a clock time with frame timestamps. */
const EPSILON = 1e-4;

/**
 * Bounded read-ahead over a decoded-frame iterator. The consumer asks for the frame to show at
 * clock time t; frames that are already late are closed and counted as dropped. Ownership of the
 * returned frame passes to the caller.
 */
export class PlaybackQueue<F extends TimedFrame> {
  private readonly queue: F[] = [];
  private filling = false;
  private exhausted = false;
  private disposed = false;
  dropped = 0;

  constructor(
    private readonly source: AsyncIterator<F>,
    private readonly capacity: number,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {
    this.fill();
  }

  /** True once the source is exhausted and every queued frame has been handed out. */
  get ended(): boolean {
    return this.exhausted && this.queue.length === 0;
  }

  get size(): number {
    return this.queue.length;
  }

  /** Returns the newest frame due at time t, or null if none is due yet. */
  take(t: number): F | null {
    let due: F | null = null;
    for (let next = this.queue[0]; next && next.timestamp <= t + EPSILON; next = this.queue[0]) {
      this.queue.shift();
      if (due) {
        due.close();
        this.dropped++;
      }
      due = next;
    }
    this.fill();
    return due;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const f of this.queue.splice(0)) f.close();
    try {
      await this.source.return?.();
    } catch {
      // Generator teardown errors are irrelevant once we've stopped consuming.
    }
  }

  private fill(): void {
    if (this.filling || this.exhausted || this.disposed) return;
    this.filling = true;
    void (async () => {
      try {
        while (!this.disposed && !this.exhausted && this.queue.length < this.capacity) {
          const r = await this.source.next();
          if (r.done) {
            this.exhausted = true;
          } else if (this.disposed) {
            r.value.close();
          } else {
            this.queue.push(r.value);
          }
        }
      } catch (err) {
        this.exhausted = true;
        if (!this.disposed) this.onError(err);
      } finally {
        this.filling = false;
      }
    })();
  }
}
