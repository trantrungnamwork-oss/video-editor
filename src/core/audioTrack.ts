/**
 * Music and voice-over rows (ADR 0013). Pure: placement, looping, fades and ducking of audio items
 * on the timeline. The preview worker and the export mix with the same functions.
 */
import { gainAt } from './audioGain';
import {
  DEFAULT_CLIP_AUDIO,
  MAX_VOLUME,
  projectDuration,
  type AudioItem,
  type AudioKind,
  type ClipAudio,
  type IdFactory,
  type MediaSource,
  type Project,
} from './project';

/** Music gain while a voice-over plays, and how long the dip takes. */
export const DUCK_LEVEL = 0.3;
export const DUCK_RAMP_SEC = 0.3;
export const MIN_AUDIO_SEC = 0.1;

const defaultId: IdFactory = () => crypto.randomUUID();
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round3 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0);

/** What mixing needs from a project (also built by the media layer with files attached). */
export type MixContext = Pick<Project, 'audioItems' | 'duck'>;

export const audioItemsOf = (p: MixContext): readonly AudioItem[] => p.audioItems ?? [];
export const duckOn = (p: MixContext) => p.duck !== false;

/** Timeline end of an item: its length, one pass when not looping, and the video's end. */
export function itemEnd(item: AudioItem, videoEnd: number): number {
  const pass = item.outSec - item.inSec;
  let end = item.startSec + (item.durationSec ?? Infinity);
  if (!item.loop) end = Math.min(end, item.startSec + pass);
  return Math.min(end, videoEnd);
}

/** Source time played at timeline time t, or null when the item is silent there. */
export function sourceAt(item: AudioItem, t: number, videoEnd: number): number | null {
  if (t < item.startSec || t >= itemEnd(item, videoEnd)) return null;
  const pass = item.outSec - item.inSec;
  const offset = t - item.startSec;
  return item.inSec + (item.loop ? offset % pass : offset);
}

/**
 * Contiguous source ranges an item plays within timeline [from, to): one per loop pass.
 * `timelineStart` is where each range starts on the timeline.
 */
export function itemPasses(
  item: AudioItem,
  from: number,
  to: number,
  videoEnd: number,
): { timelineStart: number; sourceFrom: number; sourceTo: number }[] {
  const start = Math.max(from, item.startSec);
  const end = Math.min(to, itemEnd(item, videoEnd));
  const pass = item.outSec - item.inSec;
  const out: { timelineStart: number; sourceFrom: number; sourceTo: number }[] = [];
  if (!(pass > 0)) return out;
  let t = start;
  while (end - t > 1e-6) {
    const offset = (t - item.startSec) % pass;
    const len = Math.min(end - t, pass - offset);
    out.push({
      timelineStart: t,
      sourceFrom: item.inSec + offset,
      sourceTo: item.inSec + offset + len,
    });
    t += len;
  }
  return out;
}

/** Ducking factor for music at t: dips to DUCK_LEVEL around voice-overs, with short ramps. */
export function duckAt(p: MixContext, t: number, videoEnd: number): number {
  if (!duckOn(p)) return 1;
  let cover = 0;
  for (const v of audioItemsOf(p)) {
    if (v.kind !== 'voice' || v.audio?.muted) continue;
    const a = v.startSec;
    const b = itemEnd(v, videoEnd);
    if (b <= a) continue;
    // 1 inside [a, b], ramping linearly to 0 over DUCK_RAMP_SEC on both sides.
    const d = t < a ? a - t : t > b ? t - b : 0;
    cover = Math.max(cover, Math.max(0, 1 - d / DUCK_RAMP_SEC));
  }
  return 1 - (1 - DUCK_LEVEL) * cover;
}

/** Gain of an item at timeline t: its volume and fades over its length, and ducking for music. */
export function itemGainAt(p: MixContext, item: AudioItem, t: number, videoEnd: number): number {
  const length = itemEnd(item, videoEnd) - item.startSec;
  const g = gainAt(item.audio, t - item.startSec, length);
  return item.kind === 'music' ? g * duckAt(p, t, videoEnd) : g;
}

function replaceItem(p: Project, id: string, fn: (a: AudioItem) => AudioItem): Project {
  let changed = false;
  const audioItems = audioItemsOf(p).map((a) => {
    if (a.id !== id) return a;
    const next = fn(a);
    if (JSON.stringify(next) !== JSON.stringify(a)) changed = true;
    return next;
  });
  return changed ? { ...p, audioItems } : p;
}

/**
 * Places an audio file: music from `startSec` to the end of the video, looping; a voice-over once,
 * at its own length.
 */
export function addAudioItem(
  p: Project,
  media: MediaSource,
  kind: AudioKind,
  startSec: number,
  id: IdFactory = defaultId,
): Project {
  if (!(media.durationSec > 0)) return p;
  const item: AudioItem = {
    id: id(),
    mediaId: media.id,
    kind,
    startSec: round3(Math.max(0, startSec)),
    durationSec: kind === 'music' ? null : round3(media.durationSec),
    inSec: 0,
    outSec: media.durationSec,
    loop: kind === 'music',
  };
  return {
    ...p,
    media: { ...p.media, [media.id]: media },
    audioItems: [...audioItemsOf(p), item],
  };
}

export function removeAudioItem(p: Project, id: string): Project {
  const items = audioItemsOf(p);
  const audioItems = items.filter((a) => a.id !== id);
  return audioItems.length === items.length ? p : { ...p, audioItems };
}

/** Moves an item along the timeline (never before 0 or past the video's end). */
export function moveAudioItem(p: Project, id: string, startSec: number): Project {
  const end = projectDuration(p);
  return replaceItem(p, id, (a) => ({
    ...a,
    startSec: round3(clamp(startSec, 0, Math.max(0, end - MIN_AUDIO_SEC))),
  }));
}

/** Length on the timeline (null = to the end of the video) and looping. */
export function setAudioItemLength(
  p: Project,
  id: string,
  patch: { durationSec?: number | null; loop?: boolean },
): Project {
  return replaceItem(p, id, (a) => {
    const durationSec =
      patch.durationSec === undefined
        ? a.durationSec
        : patch.durationSec === null
          ? null
          : round3(Math.max(MIN_AUDIO_SEC, patch.durationSec));
    return { ...a, durationSec, loop: patch.loop ?? a.loop };
  });
}

/** Volume, mute and fades of an item (same rules as a clip's). */
export function setAudioItemAudio(p: Project, id: string, patch: Partial<ClipAudio>): Project {
  return replaceItem(p, id, (a) => {
    const m = { ...(a.audio ?? DEFAULT_CLIP_AUDIO), ...patch };
    const audio: ClipAudio = {
      volume: clamp(round3(m.volume), 0, MAX_VOLUME),
      muted: m.muted,
      fadeInSec: Math.max(0, round3(m.fadeInSec)),
      fadeOutSec: Math.max(0, round3(m.fadeOutSec)),
    };
    const isDefault =
      audio.volume === 1 && !audio.muted && audio.fadeInSec === 0 && audio.fadeOutSec === 0;
    const next = { ...a };
    if (isDefault) delete next.audio;
    else next.audio = audio;
    return next;
  });
}

export function setDuck(p: Project, on: boolean): Project {
  if (duckOn(p) === on) return p;
  const next = { ...p };
  if (on) delete (next as { duck?: boolean }).duck;
  else (next as { duck?: boolean }).duck = false;
  return next;
}
