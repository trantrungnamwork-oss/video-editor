/**
 * Streaming conversion of decoded audio to the export format (48 kHz stereo, planar float).
 *
 * Mediabunny's encoder source requires constant audio parameters, but clips can differ (phones
 * record 44.1/48 kHz; some apps and messengers produce 22.05 kHz or mono). Linear interpolation
 * keeps state across chunks, so consecutive chunks of one clip join without clicks. It is fine for
 * the common upsampling cases; downsampling from very high rates aliases slightly.
 */
export class Resampler {
  private readonly step: number;
  /** Position of the next output sample, in input samples relative to the next chunk. */
  private pos = 0;
  private prev: number[];

  constructor(
    readonly inRate: number,
    readonly outRate: number,
    readonly outChannels: number,
  ) {
    this.step = inRate / outRate;
    this.prev = new Array<number>(outChannels).fill(0);
  }

  /** Maps any channel layout to `outChannels` (mono is duplicated; extra channels are dropped). */
  private mapChannels(planes: Float32Array[]): Float32Array[] {
    const first = planes[0] ?? new Float32Array(0);
    return Array.from(
      { length: this.outChannels },
      (_, c) => planes[c] ?? planes[planes.length - 1] ?? first,
    );
  }

  process(input: Float32Array[]): Float32Array[] {
    const planes = this.mapChannels(input);
    const n = planes[0]?.length ?? 0;
    if (n === 0) return planes.map(() => new Float32Array(0));
    if (this.inRate === this.outRate) return planes.map((p) => Float32Array.from(p));

    // Virtual input: x[-1] = last sample of the previous chunk, x[0..n-1] = this chunk.
    const count = Math.max(0, Math.floor((n - 1 - this.pos) / this.step) + 1);
    const out = planes.map(() => new Float32Array(count));
    for (let k = 0; k < count; k++) {
      const t = this.pos + k * this.step;
      const i = Math.floor(t);
      const frac = t - i;
      for (let c = 0; c < planes.length; c++) {
        const p = planes[c] as Float32Array;
        const a = i < 0 ? (this.prev[c] ?? 0) : (p[i] ?? 0);
        const b = p[i + 1] ?? a;
        (out[c] as Float32Array)[k] = a + (b - a) * frac;
      }
    }
    this.pos = this.pos + count * this.step - n;
    this.prev = planes.map((p) => p[n - 1] ?? 0);
    return out;
  }
}

/** Joins planar channels into one buffer (the layout AudioSample's 'f32-planar' expects). */
export function concatPlanes(planes: Float32Array[]): Float32Array {
  const n = planes[0]?.length ?? 0;
  const out = new Float32Array(n * planes.length);
  planes.forEach((p, c) => out.set(p, c * n));
  return out;
}
