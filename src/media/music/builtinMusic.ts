/**
 * Built-in music, synthesized on the device by this code (MIT, no third-party recordings, nothing
 * downloaded or bundled). Each track is a seamless loop; the music row repeats it to the end.
 */

export interface BuiltinTrack {
  id: string;
  name: string;
  seconds: number;
}

export const BUILTIN_TRACKS: readonly BuiltinTrack[] = [
  { id: 'calm', name: 'Calm', seconds: 16 },
  { id: 'upbeat', name: 'Upbeat', seconds: 8 },
  { id: 'ambient', name: 'Ambient', seconds: 16 },
];

const TAU = Math.PI * 2;
const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

/** Deterministic noise (mulberry32), so a track is identical every time. */
function noise(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32 - 0.5;
  };
}

/** Attack/release envelope for a note of `len` seconds at time `t` into it. */
const env = (t: number, len: number, attack: number, release: number) =>
  t < 0 || t > len ? 0 : Math.min(1, t / attack, (len - t) / release);

// C – Am – F – G, as MIDI chords.
const CHORDS = [
  [60, 64, 67],
  [57, 60, 64],
  [53, 57, 60],
  [55, 59, 62],
];

function calm(t: number, seconds: number): number {
  const barLen = seconds / CHORDS.length;
  const bar = Math.floor(t / barLen) % CHORDS.length;
  const tb = t - Math.floor(t / barLen) * barLen;
  const chord = CHORDS[bar] ?? [];
  let v = 0;
  for (const n of chord) {
    const f = midi(n);
    v += Math.sin(TAU * f * t) * 0.6 + Math.sin(TAU * f * 1.003 * t) * 0.4;
  }
  return (v / chord.length) * env(tb, barLen, 1.2, 1.2) * 0.35;
}

function upbeat(t: number, seconds: number, rnd: () => number): number {
  const beat = 0.5; // 120 bpm
  const tb = t % beat;
  const beatIndex = Math.floor(t / beat);
  // Kick: pitch-swept sine on every beat.
  const kick = Math.sin(TAU * (50 + 90 * Math.exp(-tb * 30)) * tb) * Math.exp(-tb * 9) * 0.6;
  // Hi-hat on the off-beats.
  const th = (t + beat / 2) % beat;
  const hat = rnd() * Math.exp(-th * 60) * 0.25;
  // Bass following the chords, eighth notes.
  const barLen = seconds / CHORDS.length;
  const chord = CHORDS[Math.floor(t / barLen) % CHORDS.length] ?? [60];
  const root = midi((chord[0] ?? 60) - 24);
  const te = t % (beat / 2);
  const bass = Math.sign(Math.sin(TAU * root * t)) * env(te, beat / 2, 0.005, 0.08) * 0.12;
  // Chord stab on every second beat.
  let stab = 0;
  if (beatIndex % 2 === 1) {
    for (const n of chord) stab += Math.sin(TAU * midi(n + 12) * t);
    stab *= env(tb, 0.25, 0.005, 0.2) * 0.06;
  }
  return kick + hat + bass + stab;
}

function ambient(t: number, seconds: number): number {
  const lfo = 0.5 + 0.5 * Math.sin((TAU * t) / seconds);
  const drone =
    (Math.sin(TAU * midi(48) * t) + Math.sin(TAU * midi(55) * t) * 0.7) * (0.12 + 0.08 * lfo);
  // A soft bell every 2 s, walking up a pentatonic scale.
  const scale = [72, 74, 76, 79, 81, 84, 81, 79];
  const k = Math.floor(t / 2);
  const tb = t - k * 2;
  const bell =
    Math.sin(TAU * midi(scale[k % scale.length] ?? 72) * tb) * Math.exp(-tb * 2.5) * 0.18;
  return drone + bell;
}

/** Renders a track as 16-bit stereo WAV bytes. */
export function renderBuiltinWav(id: string, rate = 44_100): Uint8Array {
  const track = BUILTIN_TRACKS.find((t) => t.id === id);
  if (!track) throw new Error(`Unknown track ${id}`);
  const frames = Math.round(track.seconds * rate);
  const data = frames * 4;
  const out = new DataView(new ArrayBuffer(44 + data));
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  out.setUint32(4, 36 + data, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 2, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 4, true);
  out.setUint16(32, 4, true);
  out.setUint16(34, 16, true);
  str(36, 'data');
  out.setUint32(40, data, true);
  const rnd = noise(7);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const v =
      id === 'calm'
        ? calm(t, track.seconds)
        : id === 'upbeat'
          ? upbeat(t, track.seconds, rnd)
          : ambient(t, track.seconds);
    const s = Math.max(-1, Math.min(1, v));
    const l = Math.round(s * 32767);
    out.setInt16(44 + i * 4, l, true);
    out.setInt16(46 + i * 4, l, true);
  }
  return new Uint8Array(out.buffer);
}
