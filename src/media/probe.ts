/**
 * Media probing: container, duration, and per-track metadata for an imported file, plus a
 * decodability check against the *actual* decoder config of the track (not a generic codec string).
 *
 * Reads through Mediabunny's BlobSource, which pulls byte ranges on demand with a bounded cache,
 * so the file is never loaded into memory as a whole (CLAUDE.md §3.2).
 */
import {
  ADTS,
  BlobSource,
  FLAC,
  Input,
  MATROSKA,
  MP3,
  MP4,
  MPEG_TS,
  OGG,
  QTFF,
  WAVE,
  WEBM,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny';
import { probeConfig, PROBE_TIMEOUT_MS, type ConfigProber, type ProbeResult } from './capabilities';

/**
 * Containers the WebCodecs pipeline handles: MP4/MOV (phones), WebM/MKV, and MPEG-TS
 * (.ts/.mts/.m2ts from camcorders and some apps). Anything else is refused with a clear message;
 * see TL-006 for why there is no FFmpeg.wasm fallback.
 */
export const SUPPORTED_INPUT_FORMATS = [
  MP4,
  QTFF,
  WEBM,
  MATROSKA,
  MPEG_TS,
  MP3,
  WAVE,
  OGG,
  ADTS,
  FLAC,
];

/** Enough to cover a moov/cues lookup without holding large chunks of the file. */
const SOURCE_CACHE_BYTES = 4 * 1024 * 1024;

/** Packets inspected for frame-rate estimation (Mediabunny's recommended minimum). */
const FRAME_RATE_PROBE_PACKETS = 256;

export type MediaProbeErrorCode = 'unsupported-format' | 'no-video-track' | 'read-failed';

export interface MediaProbeErrorInfo {
  code: MediaProbeErrorCode;
  message: string;
}

export class MediaProbeError extends Error implements MediaProbeErrorInfo {
  override readonly name = 'MediaProbeError';
  constructor(
    readonly code: MediaProbeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type MediaWarning =
  'video-undecodable' | 'audio-undecodable' | 'no-audio' | 'hdr' | 'variable-frame-rate';

export interface VideoStreamInfo {
  /** Mediabunny codec id: 'avc' | 'hevc' | 'vp9' | 'av1' | 'vp8' | 'prores', or null if unknown. */
  codec: string | null;
  /** Full WebCodecs codec string, e.g. 'avc1.640028'. */
  codecString: string | null;
  codedWidth: number;
  codedHeight: number;
  /** Width/height after pixel aspect ratio and rotation, i.e. what the user sees. */
  displayWidth: number;
  displayHeight: number;
  rotation: 0 | 90 | 180 | 270;
  /** Best-guess frame rate, derived from packet timestamps rather than container metadata. */
  frameRate: number | null;
  isVariableFrameRate: boolean;
  hdr: boolean;
  decode: ProbeResult;
}

export interface AudioStreamInfo {
  codec: string | null;
  codecString: string | null;
  sampleRate: number;
  channels: number;
  decode: ProbeResult;
}

export interface MediaInfo {
  name: string;
  sizeBytes: number;
  /** Container name as reported by the demuxer, e.g. 'MP4', 'QuickTime File Format', 'WebM'. */
  container: string;
  mimeType: string;
  durationSec: number;
  /** 'audio': an audio-only file (music, voice-over); it goes on the audio rows, not the clips. */
  kind: 'video' | 'audio';
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
  warnings: MediaWarning[];
  /** False when the main stream (video, or audio for audio-only files) can't be decoded here. */
  canDecode: boolean;
}

export interface ProbeEnv {
  VideoDecoder?: ConfigProber<VideoDecoderConfig> | undefined;
  AudioDecoder?: ConfigProber<AudioDecoderConfig> | undefined;
  timeoutMs?: number;
  /** Observes every byte range pulled from the file (I/O accounting in tests and diagnostics). */
  onRead?: (start: number, end: number) => void;
}

export function getProbeEnv(): ProbeEnv {
  const g = globalThis as Partial<typeof globalThis>;
  return { VideoDecoder: g.VideoDecoder, AudioDecoder: g.AudioDecoder };
}

export async function probeMedia(
  blob: Blob,
  name: string,
  env: ProbeEnv = getProbeEnv(),
): Promise<MediaInfo> {
  const source = new BlobSource(blob, { maxCacheSize: SOURCE_CACHE_BYTES });
  const { onRead } = env;
  if (onRead) source.on('read', ({ start, end }) => onRead(start, end));
  const input = new Input({ source, formats: SUPPORTED_INPUT_FORMATS });
  try {
    if (!(await input.canRead())) {
      throw new MediaProbeError('unsupported-format', 'Unrecognised or unsupported container');
    }
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!videoTrack && !audioTrack) {
      throw new MediaProbeError('no-video-track', 'File has no video or audio track');
    }
    const timeoutMs = env.timeoutMs ?? PROBE_TIMEOUT_MS;

    const [format, mimeType, durationSec, video, audio] = await Promise.all([
      input.getFormat(),
      input.getMimeType(),
      input.computeDuration(),
      videoTrack ? describeVideo(videoTrack, env, timeoutMs) : Promise.resolve(null),
      audioTrack ? describeAudio(audioTrack, env, timeoutMs) : Promise.resolve(null),
    ]);

    const warnings: MediaWarning[] = [];
    if (video && video.decode.status !== 'supported') warnings.push('video-undecodable');
    if (!audio) warnings.push('no-audio');
    else if (audio.decode.status !== 'supported') warnings.push('audio-undecodable');
    if (video?.hdr) warnings.push('hdr');
    if (video?.isVariableFrameRate) warnings.push('variable-frame-rate');

    return {
      name,
      sizeBytes: blob.size,
      container: format.name,
      mimeType,
      durationSec,
      kind: video ? 'video' : 'audio',
      video,
      audio,
      warnings,
      canDecode: (video ?? audio)?.decode.status === 'supported',
    };
  } catch (err) {
    if (err instanceof MediaProbeError) throw err;
    throw new MediaProbeError('read-failed', err instanceof Error ? err.message : String(err));
  } finally {
    input.dispose();
  }
}

async function describeVideo(
  track: InputVideoTrack,
  env: ProbeEnv,
  timeoutMs: number,
): Promise<VideoStreamInfo> {
  const [
    codec,
    codecString,
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    rotation,
    hdr,
    config,
    frameRate,
  ] = await Promise.all([
    track.getCodec(),
    track.getCodecParameterString(),
    track.getCodedWidth(),
    track.getCodedHeight(),
    track.getDisplayWidth(),
    track.getDisplayHeight(),
    track.getRotation(),
    track.hasHighDynamicRange(),
    track.getDecoderConfig(),
    track
      .computeFrameRateMetrics({ targetPacketCount: FRAME_RATE_PROBE_PACKETS })
      .catch(() => null),
  ]);
  return {
    codec,
    codecString,
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    rotation,
    frameRate: frameRate ? roundFps(frameRate.bestGuessFrameRate) : null,
    // Too few packets to tell (very short clips) is not evidence of VFR.
    isVariableFrameRate:
      !!frameRate && frameRate.probedPacketCount > 2 && frameRate.underlyingFrameRate === null,
    hdr,
    decode: config ? await probeConfig(env.VideoDecoder, config, timeoutMs) : unknownCodec(),
  };
}

async function describeAudio(
  track: InputAudioTrack,
  env: ProbeEnv,
  timeoutMs: number,
): Promise<AudioStreamInfo> {
  const [codec, codecString, sampleRate, channels, config] = await Promise.all([
    track.getCodec(),
    track.getCodecParameterString(),
    track.getSampleRate(),
    track.getNumberOfChannels(),
    track.getDecoderConfig(),
  ]);
  return {
    codec,
    codecString,
    sampleRate,
    channels,
    decode: config ? await probeConfig(env.AudioDecoder, config, timeoutMs) : unknownCodec(),
  };
}

const unknownCodec = (): ProbeResult => ({ status: 'unsupported', error: 'Unknown codec' });

const roundFps = (fps: number) => Math.round(fps * 1000) / 1000;
