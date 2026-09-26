/**
 * Builds tiny, valid containers from fake encoded packets. Demuxing only needs well-formed
 * container metadata, so these exercise the probe path without binary fixtures or an encoder.
 * The packets are not decodable; never feed them to a real decoder.
 */
import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  MkvOutputFormat,
  Mp4OutputFormat,
  MovOutputFormat,
  Output,
  WebMOutputFormat,
  type Rotation,
} from 'mediabunny';

export interface SyntheticOptions {
  container: 'mp4' | 'mov' | 'webm' | 'mkv';
  video: 'avc' | 'hevc' | 'vp9' | 'av1';
  audio?: 'aac' | 'opus' | null;
  width?: number;
  height?: number;
  fps?: number;
  durationSec?: number;
  rotation?: Rotation;
  /** Jitter frame timestamps to simulate variable frame rate. */
  variableFrameRate?: boolean;
  /** Payload size per video packet, to build files large enough for I/O tests. */
  videoPacketBytes?: number;
}

// Minimal but structurally valid codec-private records.
const AVCC = new Uint8Array([1, 0x64, 0x00, 0x28, 0xff, 0xe0, 0x00]);
const HVCC = new Uint8Array([
  1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 120, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0,
]);
const AAC_LC_48K_STEREO = new Uint8Array([0x11, 0x90]);

const VIDEO_CODEC_STRING = {
  avc: 'avc1.640028',
  hevc: 'hvc1.1.6.L120.90',
  vp9: 'vp09.00.40.08',
  av1: 'av01.0.08M.08',
} as const;

export async function createSyntheticVideo(opts: SyntheticOptions): Promise<Uint8Array> {
  const {
    container,
    video,
    audio = null,
    width = 1920,
    height = 1080,
    fps = 30,
    durationSec = 2,
    rotation = 0,
    variableFrameRate = false,
    videoPacketBytes = 5,
  } = opts;

  const format = {
    mp4: () => new Mp4OutputFormat(),
    mov: () => new MovOutputFormat(),
    webm: () => new WebMOutputFormat(),
    mkv: () => new MkvOutputFormat(),
  }[container]();
  const output = new Output({ format, target: new BufferTarget() });

  const videoSource = new EncodedVideoPacketSource(video);
  // frameRate makes the muxer snap timestamps to a 1/fps grid, which would erase the jitter.
  output.addVideoTrack(
    videoSource,
    variableFrameRate ? { rotation } : { frameRate: fps, rotation },
  );
  const audioSource = audio ? new EncodedAudioPacketSource(audio) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();

  const description = video === 'avc' ? AVCC : video === 'hevc' ? HVCC : undefined;
  const frameCount = Math.round(durationSec * fps);
  let t = 0;
  for (let i = 0; i < frameCount; i++) {
    // Irregular, non-lattice spacing so no underlying constant rate can be fitted.
    const dur = variableFrameRate ? (1 + 0.45 * Math.sin(i * 1.37)) / fps : 1 / fps;
    const payload = new Uint8Array(videoPacketBytes);
    payload[payload.length - 1] = i & 0xff;
    const packet = new EncodedPacket(payload, i % fps === 0 ? 'key' : 'delta', t, dur);
    await videoSource.add(
      packet,
      i === 0
        ? {
            decoderConfig: {
              codec: VIDEO_CODEC_STRING[video],
              codedWidth: width,
              codedHeight: height,
              ...(description ? { description } : {}),
            },
          }
        : undefined,
    );
    t += dur;
  }

  if (audioSource) {
    const frame = 0.02;
    for (let i = 0; i * frame < durationSec; i++) {
      await audioSource.add(
        new EncodedPacket(new Uint8Array([1, 2, 3]), 'key', i * frame, frame),
        i === 0
          ? {
              decoderConfig: {
                codec: audio === 'aac' ? 'mp4a.40.2' : 'opus',
                sampleRate: 48_000,
                numberOfChannels: 2,
                ...(audio === 'aac' ? { description: AAC_LC_48K_STEREO } : {}),
              },
            }
          : undefined,
      );
    }
  }

  await output.finalize();
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('Synthetic output produced no data');
  return new Uint8Array(buffer);
}
