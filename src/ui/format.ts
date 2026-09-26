const VIDEO_CODEC_LABELS: Record<string, string> = {
  avc: 'H.264',
  hevc: 'HEVC',
  vp9: 'VP9',
  av1: 'AV1',
  vp8: 'VP8',
  prores: 'ProRes',
};

const AUDIO_CODEC_LABELS: Record<string, string> = {
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
};

export const videoCodecLabel = (c: string | null) =>
  c ? (VIDEO_CODEC_LABELS[c] ?? c.toUpperCase()) : 'Unknown';

export const audioCodecLabel = (c: string | null) =>
  c ? (AUDIO_CODEC_LABELS[c] ?? c.toUpperCase()) : 'Unknown';

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function formatDuration(sec: number): string {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toFixed(1).padStart(4, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export const formatFps = (fps: number | null) =>
  fps === null ? '?' : Number.isInteger(fps) ? String(fps) : fps.toFixed(2);
