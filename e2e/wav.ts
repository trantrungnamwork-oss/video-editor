/** 16-bit PCM WAV builder for e2e fixtures (tones, silence). */
export function wav(opts: {
  rate?: number;
  channels?: number;
  seconds: number;
  /** Peak amplitude of a sine (0 = silence). */
  amplitude?: number;
  hz?: number;
}): Buffer {
  const { rate = 44_100, channels = 1, seconds, amplitude = 0, hz = 440 } = opts;
  const frames = Math.round(rate * seconds);
  const data = frames * channels * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(data, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / rate) * 32767);
    for (let c = 0; c < channels; c++) buf.writeInt16LE(v, 44 + (i * channels + c) * 2);
  }
  return buf;
}
