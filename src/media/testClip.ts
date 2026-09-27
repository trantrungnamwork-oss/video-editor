/**
 * Generates a real, decodable test clip with the device's own encoders. Each frame shows its
 * frame number and timecode; every whole second flashes white while a 1 kHz beep plays, so A/V
 * sync can be checked by eye and ear on real devices. Must run where OffscreenCanvas and
 * WebCodecs encoders exist (a worker).
 */
import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
} from 'mediabunny';

export interface TestClipSpec {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  /** Audio sample rate (default 48 kHz) and channel count (default stereo). */
  sampleRate?: number;
  channels?: number;
}

export const DEFAULT_TEST_CLIP: TestClipSpec = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationSec: 10,
};

const AUDIO_CHUNK_FRAMES = 1024;
const BEEP_SEC = 0.1;
const FLASH_FRAMES = 3;

/** Parses "WIDTHxHEIGHTxSECONDS[@FPS[:RATE[:CHANNELS]]]", e.g. "1280x720x4@30:24000:1". */
export function parseTestClipSpec(s: string | null): TestClipSpec | null {
  const m = s?.match(/^(\d+)x(\d+)x(\d+(?:\.\d+)?)(?:@(\d+)(?::(\d+)(?::(\d+))?)?)?$/);
  if (!m) return null;
  const [, w, h, sec, fps, rate, ch] = m;
  return {
    width: Number(w),
    height: Number(h),
    durationSec: Number(sec),
    fps: fps ? +fps : 30,
    ...(rate ? { sampleRate: +rate } : {}),
    ...(ch ? { channels: +ch } : {}),
  };
}

export async function generateTestClip(spec: TestClipSpec): Promise<File> {
  const { width, height, fps, durationSec } = spec;
  const rate = spec.sampleRate ?? 48_000;
  const channels = spec.channels ?? 2;
  const pair = await pickCodecs(width, height, rate, channels);
  if (!pair) throw new Error('No encodable video/audio codec pair on this device');

  const output = new Output({
    format:
      pair.container === 'mp4'
        ? new Mp4OutputFormat({ fastStart: 'in-memory' })
        : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');

  const video = new CanvasSource(canvas, {
    codec: pair.video,
    bitrate: width * height * fps * 0.1,
    keyFrameInterval: 1,
    latencyMode: 'realtime',
  });
  const audio = new AudioSampleSource({ codec: pair.audio, bitrate: 128_000 });
  output.addVideoTrack(video, { frameRate: fps });
  output.addAudioTrack(audio);
  await output.start();

  const frameCount = Math.round(durationSec * fps);
  const totalAudioFrames = Math.round(durationSec * rate);
  let audioPos = 0;

  for (let i = 0; i < frameCount; i++) {
    const t = i / fps;
    drawFrame(ctx, width, height, i, fps);
    await video.add(t, 1 / fps);

    // Keep audio interleaved with video so the muxer never buffers much.
    // The last frame also flushes any audio that outlasts the video (durationSec not a whole
    // number of frames), like the AAC padding on real recordings.
    const audioUntil =
      i === frameCount - 1
        ? totalAudioFrames
        : Math.min(totalAudioFrames, Math.round(((i + 1) / fps) * rate));
    while (audioPos < audioUntil) {
      const n = Math.min(AUDIO_CHUNK_FRAMES, totalAudioFrames - audioPos);
      const sample = new AudioSample({
        data: beepChunk(audioPos, n, rate, channels),
        format: 'f32-planar',
        numberOfChannels: channels,
        sampleRate: rate,
        timestamp: audioPos / rate,
      });
      await audio.add(sample);
      sample.close();
      audioPos += n;
    }
  }

  await output.finalize();
  const buffer = output.target.buffer;
  if (!buffer) throw new Error('Encoder produced no data');
  const name = `test-${width}x${height}-${fps}fps-${durationSec}s.${pair.container}`;
  return new File([buffer], name, { type: pair.container === 'mp4' ? 'video/mp4' : 'video/webm' });
}

async function pickCodecs(width: number, height: number, sampleRate: number, channels: number) {
  const pairs = [
    { container: 'mp4', video: 'avc', audio: 'aac' },
    { container: 'webm', video: 'vp9', audio: 'opus' },
  ] as const;
  for (const p of pairs) {
    const [v, a] = await Promise.all([
      getFirstEncodableVideoCodec([p.video], { width, height }),
      getFirstEncodableAudioCodec([p.audio], { numberOfChannels: channels, sampleRate }),
    ]);
    if (v && a) return p;
  }
  return null;
}

function drawFrame(
  ctx: OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
  frame: number,
  fps: number,
) {
  const flash = frame % fps < FLASH_FRAMES;
  ctx.fillStyle = flash ? '#ffffff' : `hsl(${(frame * 3) % 360} 45% 22%)`;
  ctx.fillRect(0, 0, w, h);

  // Sweeping bar: makes dropped or repeated frames visible.
  ctx.fillStyle = flash ? '#000000' : '#22c55e';
  const barW = Math.max(4, Math.round(w / 60));
  ctx.fillRect(Math.round(((frame % fps) / fps) * (w - barW)), 0, barW, h);

  ctx.fillStyle = flash ? '#000000' : '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(h / 5)}px system-ui, sans-serif`;
  ctx.fillText(String(frame), w / 2, h * 0.42);
  ctx.font = `${Math.round(h / 14)}px ui-monospace, monospace`;
  ctx.fillText(formatTimecode(frame, fps), w / 2, h * 0.68);
}

function formatTimecode(frame: number, fps: number) {
  const s = Math.floor(frame / fps);
  const ff = frame % fps;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}

/** Planar chunk: 1 kHz tone for the first BEEP_SEC of every second, silence otherwise. */
function beepChunk(startFrame: number, n: number, rate: number, channels: number): Float32Array {
  const data = new Float32Array(n * channels);
  for (let i = 0; i < n; i++) {
    const t = (startFrame + i) / rate;
    const v = t % 1 < BEEP_SEC ? 0.3 * Math.sin(2 * Math.PI * 1000 * t) : 0;
    for (let c = 0; c < channels; c++) data[c * n + i] = v;
  }
  return data;
}
