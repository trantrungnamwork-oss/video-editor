/**
 * Counts live VideoSample/VideoFrame-like objects. Every decoded frame goes through `track()`,
 * which wraps `close()` so leaks show up as a non-zero `open` count (CLAUDE.md §3.6: a leaked
 * frame can crash the tab on iOS).
 */
export interface Closable {
  close(): void;
}

export class FrameTracker {
  open = 0;
  peak = 0;
  total = 0;
  private readonly live = new WeakSet<Closable>();

  track<T extends Closable>(frame: T): T {
    if (this.live.has(frame)) return frame;
    this.live.add(frame);
    this.open++;
    this.total++;
    this.peak = Math.max(this.peak, this.open);
    const close = frame.close.bind(frame);
    frame.close = () => {
      if (this.live.delete(frame)) this.open--;
      close();
    };
    return frame;
  }
}
