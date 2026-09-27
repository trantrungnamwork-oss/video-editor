/**
 * Audio items with their files, as sent to the preview and export workers. Same shape as the
 * project's MixContext, so core/audioTrack.ts functions apply directly.
 */
import type { AudioItem } from '../core/project';

export interface MixItem extends AudioItem {
  file: File;
}

export interface AudioMix {
  audioItems: MixItem[];
  duck: boolean;
}

export const NO_MIX: AudioMix = { audioItems: [], duck: true };
