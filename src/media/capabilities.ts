/**
 * Device capability detection.
 *
 * Everything here is feature-detected: WebCodecs via `isConfigSupported()`, platform APIs via
 * presence checks or real round-trips. User-agent sniffing is forbidden (CLAUDE.md §3.4); the UA
 * string is only copied into the report as informational metadata for bug reports.
 *
 * This module must stay framework-agnostic (no React imports).
 */

export const RESOLUTIONS = {
  '720p': { width: 1280, height: 720, bitrate: 5_000_000 },
  '1080p': { width: 1920, height: 1080, bitrate: 10_000_000 },
  '4k': { width: 3840, height: 2160, bitrate: 35_000_000 },
} as const;

export type Resolution = keyof typeof RESOLUTIONS;
export type VideoCodecId = 'h264' | 'hevc' | 'vp9' | 'av1';
export type AudioCodecId = 'aac' | 'opus';

/**
 * Codec strings per resolution. Levels are picked so that each string is the lowest level that
 * covers the resolution at 30 fps; asking for a higher level than needed can produce false
 * negatives on low-end hardware decoders.
 */
export const VIDEO_CODEC_STRINGS: Record<VideoCodecId, Record<Resolution, string>> = {
  // H.264 High profile: level 3.1 / 4.0 / 5.1
  h264: { '720p': 'avc1.64001F', '1080p': 'avc1.640028', '4k': 'avc1.640033' },
  // HEVC Main profile, Main tier: level 3.1 / 4.0 / 5.1
  hevc: { '720p': 'hvc1.1.6.L93.B0', '1080p': 'hvc1.1.6.L120.B0', '4k': 'hvc1.1.6.L153.B0' },
  // VP9 profile 0, 8-bit: level 3.1 / 4.0 / 5.1
  vp9: { '720p': 'vp09.00.31.08', '1080p': 'vp09.00.40.08', '4k': 'vp09.00.51.08' },
  // AV1 Main profile, 8-bit: seq_level_idx 3.1 (5) / 4.0 (8) / 5.1 (13)
  av1: { '720p': 'av01.0.05M.08', '1080p': 'av01.0.08M.08', '4k': 'av01.0.13M.08' },
};

export const AUDIO_CODEC_STRINGS: Record<AudioCodecId, string> = {
  aac: 'mp4a.40.2', // AAC-LC
  opus: 'opus',
};

const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = 128_000;
const FRAMERATE = 30;

/** Safari has historically hung on some isConfigSupported() calls; never await forever. */
export const PROBE_TIMEOUT_MS = 5_000;

export type ProbeStatus = 'supported' | 'unsupported' | 'no-api' | 'error' | 'timeout';

export interface ProbeResult {
  status: ProbeStatus;
  /** Error message when status is 'error'. */
  error?: string;
}

export interface CodecSupport {
  codec: string;
  decode: ProbeResult;
  encode: ProbeResult;
}

export type FeatureStatus = ProbeResult;

export interface CapabilityReport {
  schemaVersion: 1;
  generatedAt: string;
  durationMs: number;
  /** Informational metadata only. Never branch on these values. */
  environment: {
    userAgent: string | null;
    hardwareConcurrency: number | null;
    deviceMemoryGB: number | null;
    devicePixelRatio: number | null;
    screen: { width: number; height: number } | null;
  };
  webCodecs: {
    VideoDecoder: boolean;
    VideoEncoder: boolean;
    AudioDecoder: boolean;
    AudioEncoder: boolean;
  };
  video: Record<VideoCodecId, Record<Resolution, CodecSupport>>;
  audio: Record<AudioCodecId, CodecSupport>;
  features: {
    crossOriginIsolated: FeatureStatus;
    sharedArrayBuffer: FeatureStatus;
    opfs: FeatureStatus;
    /** OPFS sync access handle, probed inside a dedicated worker (the only place it exists). */
    opfsSyncAccessHandle: FeatureStatus;
    offscreenCanvasInWorker: FeatureStatus;
    webCodecsInWorker: FeatureStatus;
    wakeLock: FeatureStatus;
    webShare: FeatureStatus;
    webShareFiles: FeatureStatus;
  };
  storage: { quotaBytes: number; usageBytes: number } | null;
  exportPlan: ExportPlan;
}

export interface ExportPlan {
  container: 'mp4' | 'webm' | null;
  videoCodec: VideoCodecId | null;
  audioCodec: AudioCodecId | null;
  /** Highest resolution the chosen video encoder accepts. */
  maxResolution: Resolution | null;
  /** True when we had to fall back from the default MP4 (H.264 + AAC). */
  isFallback: boolean;
}

// --- Environment abstraction (lets tests inject fakes; keeps this module pure) ---

export interface ConfigProber<C> {
  isConfigSupported(config: C): Promise<{ supported?: boolean | undefined }>;
}

export interface WorkerProbeResult {
  opfsSyncAccessHandle: FeatureStatus;
  offscreenCanvas: FeatureStatus;
  webCodecs: FeatureStatus;
}

export interface CapabilityEnv {
  VideoDecoder?: ConfigProber<VideoDecoderConfig> | undefined;
  VideoEncoder?: ConfigProber<VideoEncoderConfig> | undefined;
  AudioDecoder?: ConfigProber<AudioDecoderConfig> | undefined;
  AudioEncoder?: ConfigProber<AudioEncoderConfig> | undefined;
  crossOriginIsolated: boolean;
  hasSharedArrayBuffer: boolean;
  navigator?: Partial<Navigator> & { deviceMemory?: number };
  devicePixelRatio?: number;
  screen?: { width: number; height: number };
  /** Runs probes that are only meaningful inside a dedicated worker. */
  probeWorker?: () => Promise<WorkerProbeResult>;
  now?: () => number;
  timeoutMs?: number;
}

export function getBrowserEnv(): CapabilityEnv {
  const g = globalThis as typeof globalThis & Partial<Window>;
  return {
    VideoDecoder: g.VideoDecoder,
    VideoEncoder: g.VideoEncoder,
    AudioDecoder: g.AudioDecoder,
    AudioEncoder: g.AudioEncoder,
    crossOriginIsolated: g.crossOriginIsolated === true,
    hasSharedArrayBuffer: typeof g.SharedArrayBuffer === 'function',
    ...(g.navigator ? { navigator: g.navigator } : {}),
    ...(g.devicePixelRatio !== undefined ? { devicePixelRatio: g.devicePixelRatio } : {}),
    ...(g.screen ? { screen: { width: g.screen.width, height: g.screen.height } } : {}),
    probeWorker: runWorkerProbe,
  };
}

// --- Probing helpers ---

const ok = (supported: boolean): ProbeResult => ({
  status: supported ? 'supported' : 'unsupported',
});

function errorResult(err: unknown): ProbeResult {
  return { status: 'error', error: err instanceof Error ? err.message : String(err) };
}

async function withTimeout(p: Promise<ProbeResult>, ms: number): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function probeConfig<C>(
  api: ConfigProber<C> | undefined,
  config: C,
  timeoutMs: number,
): Promise<ProbeResult> {
  if (!api || typeof api.isConfigSupported !== 'function') return { status: 'no-api' };
  const attempt = (async () => {
    try {
      const res = await api.isConfigSupported(config);
      return ok(res.supported === true);
    } catch (err) {
      // TypeError = config the browser considers invalid, i.e. not supported here.
      if (err instanceof TypeError) return { status: 'unsupported', error: err.message } as const;
      return errorResult(err);
    }
  })();
  return withTimeout(attempt, timeoutMs);
}

async function probeVideo(
  env: CapabilityEnv,
  id: VideoCodecId,
  res: Resolution,
  timeoutMs: number,
): Promise<CodecSupport> {
  const codec = VIDEO_CODEC_STRINGS[id][res];
  const { width, height, bitrate } = RESOLUTIONS[res];
  const [decode, encode] = await Promise.all([
    probeConfig(env.VideoDecoder, { codec, codedWidth: width, codedHeight: height }, timeoutMs),
    probeConfig(
      env.VideoEncoder,
      { codec, width, height, bitrate, framerate: FRAMERATE },
      timeoutMs,
    ),
  ]);
  return { codec, decode, encode };
}

async function probeAudio(
  env: CapabilityEnv,
  id: AudioCodecId,
  timeoutMs: number,
): Promise<CodecSupport> {
  const codec = AUDIO_CODEC_STRINGS[id];
  const base = { codec, sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: AUDIO_CHANNELS };
  const [decode, encode] = await Promise.all([
    probeConfig(env.AudioDecoder, base, timeoutMs),
    probeConfig(env.AudioEncoder, { ...base, bitrate: AUDIO_BITRATE }, timeoutMs),
  ]);
  return { codec, decode, encode };
}

async function probeOpfs(env: CapabilityEnv, timeoutMs: number): Promise<ProbeResult> {
  const storage = env.navigator?.storage;
  if (!storage || typeof storage.getDirectory !== 'function') return { status: 'no-api' };
  return withTimeout(
    storage.getDirectory().then(
      () => ok(true),
      (err: unknown) => errorResult(err),
    ),
    timeoutMs,
  );
}

async function probeStorage(env: CapabilityEnv): Promise<CapabilityReport['storage']> {
  const storage = env.navigator?.storage;
  if (!storage || typeof storage.estimate !== 'function') return null;
  try {
    const { quota, usage } = await storage.estimate();
    return { quotaBytes: quota ?? 0, usageBytes: usage ?? 0 };
  } catch {
    return null;
  }
}

function probeWebShareFiles(env: CapabilityEnv): ProbeResult {
  const nav = env.navigator;
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') {
    return { status: 'no-api' };
  }
  try {
    const file = new File([new Uint8Array(0)], 'probe.mp4', { type: 'video/mp4' });
    return ok(nav.canShare({ files: [file] }));
  } catch (err) {
    return errorResult(err);
  }
}

const presence = (present: boolean): ProbeResult => (present ? ok(true) : { status: 'no-api' });

const WORKER_UNAVAILABLE: WorkerProbeResult = {
  opfsSyncAccessHandle: { status: 'no-api' },
  offscreenCanvas: { status: 'no-api' },
  webCodecs: { status: 'no-api' },
};

async function probeWorkerSafe(env: CapabilityEnv, timeoutMs: number): Promise<WorkerProbeResult> {
  if (!env.probeWorker) return WORKER_UNAVAILABLE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<WorkerProbeResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          opfsSyncAccessHandle: { status: 'timeout' },
          offscreenCanvas: { status: 'timeout' },
          webCodecs: { status: 'timeout' },
        }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([env.probeWorker(), timedOut]);
  } catch (err) {
    const e = errorResult(err);
    return { opfsSyncAccessHandle: e, offscreenCanvas: e, webCodecs: e };
  } finally {
    clearTimeout(timer);
  }
}

// --- Export plan ---

const RES_DESC: Resolution[] = ['4k', '1080p', '720p'];

function maxEncodeResolution(
  video: CapabilityReport['video'],
  id: VideoCodecId,
): Resolution | null {
  return RES_DESC.find((r) => video[id][r].encode.status === 'supported') ?? null;
}

/**
 * MVP rule (CLAUDE.md §6.6): MP4 (H.264 + AAC) by default; WebM (VP9 + Opus) when the device
 * cannot encode AAC or H.264. Export needs at least 720p to be considered usable.
 */
export function planExport(
  video: CapabilityReport['video'],
  audio: CapabilityReport['audio'],
): ExportPlan {
  const candidates = [
    { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac' },
    { container: 'webm', videoCodec: 'vp9', audioCodec: 'opus' },
  ] as const;
  for (const [i, c] of candidates.entries()) {
    const maxResolution = maxEncodeResolution(video, c.videoCodec);
    if (maxResolution && audio[c.audioCodec].encode.status === 'supported') {
      return { ...c, maxResolution, isFallback: i > 0 };
    }
  }
  return {
    container: null,
    videoCodec: null,
    audioCodec: null,
    maxResolution: null,
    isFallback: true,
  };
}

// --- Entry point ---

const VIDEO_IDS = Object.keys(VIDEO_CODEC_STRINGS) as VideoCodecId[];
const AUDIO_IDS = Object.keys(AUDIO_CODEC_STRINGS) as AudioCodecId[];
const RES_IDS = Object.keys(RESOLUTIONS) as Resolution[];

export async function detectCapabilities(
  env: CapabilityEnv = getBrowserEnv(),
): Promise<CapabilityReport> {
  const now = env.now ?? (() => performance.now());
  const timeoutMs = env.timeoutMs ?? PROBE_TIMEOUT_MS;
  const start = now();

  const videoEntries = Promise.all(
    VIDEO_IDS.map(async (id) => {
      const perRes = await Promise.all(
        RES_IDS.map(async (r) => [r, await probeVideo(env, id, r, timeoutMs)] as const),
      );
      return [id, Object.fromEntries(perRes) as Record<Resolution, CodecSupport>] as const;
    }),
  );
  const audioEntries = Promise.all(
    AUDIO_IDS.map(async (id) => [id, await probeAudio(env, id, timeoutMs)] as const),
  );

  const [videoList, audioList, opfs, storage, worker] = await Promise.all([
    videoEntries,
    audioEntries,
    probeOpfs(env, timeoutMs),
    probeStorage(env),
    probeWorkerSafe(env, timeoutMs),
  ]);

  const video = Object.fromEntries(videoList) as CapabilityReport['video'];
  const audio = Object.fromEntries(audioList) as CapabilityReport['audio'];
  const nav = env.navigator;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(now() - start),
    environment: {
      userAgent: nav?.userAgent ?? null,
      hardwareConcurrency: nav?.hardwareConcurrency ?? null,
      deviceMemoryGB: nav?.deviceMemory ?? null,
      devicePixelRatio: env.devicePixelRatio ?? null,
      screen: env.screen ?? null,
    },
    webCodecs: {
      VideoDecoder: !!env.VideoDecoder,
      VideoEncoder: !!env.VideoEncoder,
      AudioDecoder: !!env.AudioDecoder,
      AudioEncoder: !!env.AudioEncoder,
    },
    video,
    audio,
    features: {
      crossOriginIsolated: ok(env.crossOriginIsolated),
      sharedArrayBuffer: presence(env.hasSharedArrayBuffer),
      opfs,
      opfsSyncAccessHandle: worker.opfsSyncAccessHandle,
      offscreenCanvasInWorker: worker.offscreenCanvas,
      webCodecsInWorker: worker.webCodecs,
      wakeLock: presence(!!nav && 'wakeLock' in nav && !!nav.wakeLock),
      webShare: presence(typeof nav?.share === 'function'),
      webShareFiles: probeWebShareFiles(env),
    },
    storage,
    exportPlan: planExport(video, audio),
  };
}

// --- Worker-side probe ---

function runWorkerProbe(): Promise<WorkerProbeResult> {
  if (typeof Worker === 'undefined') return Promise.resolve(WORKER_UNAVAILABLE);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/capabilities.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<WorkerProbeResult>) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Capability worker failed to start'));
    };
  });
}
