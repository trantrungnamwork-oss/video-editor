import { useEffect, useRef, useState } from 'react';
import type { PreviewPlayer } from '../media/preview/previewPlayer';
import { BUILTIN_TRACKS } from '../media/music/builtinMusic';
import { builtinTrackFile } from '../media/music/musicClient';
import { useMediaStore } from '../state/mediaStore';
import { placeAudioWhenReady } from '../state/projectStore';

const BTN =
  'min-h-11 rounded-lg bg-neutral-800 px-3 text-sm font-medium active:bg-neutral-700 disabled:opacity-40';

/** Recording formats in order of preference; the first the browser can record is used. */
const RECORD_TYPES = [
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/mp4', ext: 'm4a' },
  { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
];

/**
 * "Add music" (an audio file, from the start, repeated to the end) and "Record voice" (from the
 * playhead, while the video plays silently so the mic doesn't pick up the preview).
 */
export function AudioButtons({ player }: { player: PreviewPlayer | null }) {
  const input = useRef<HTMLInputElement>(null);
  const addFiles = useMediaStore((s) => s.addFiles);
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; startSec: number } | null>(
    null,
  );
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);

  const stop = () => {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    player?.pause();
    player?.setMuted(false);
    r.recorder.stop();
    setRecording(false);
  };

  useEffect(() => {
    if (!recording) return;
    const since = performance.now();
    const id = setInterval(() => setSeconds(Math.floor((performance.now() - since) / 1000)), 250);
    // Stop when the video reaches its end.
    const off = player?.subscribe((s) => {
      if (!s.playing && rec.current) stop();
    });
    return () => {
      clearInterval(id);
      off?.();
    };
    // stop only reads refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, player]);

  const start = async () => {
    if (!player) return;
    setError(null);
    const type = RECORD_TYPES.find((t) => MediaRecorder.isTypeSupported(t.mime));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const recorder = new MediaRecorder(stream, type ? { mimeType: type.mime } : undefined);
      const chunks: Blob[] = [];
      const startSec = player.currentTime;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const mime = recorder.mimeType || type?.mime || 'audio/webm';
        const ext =
          RECORD_TYPES.find((t) => mime.startsWith(t.mime.split(';')[0] ?? ''))?.ext ?? 'webm';
        const file = new File(chunks, `voice-${Date.now()}.${ext}`, {
          type: mime,
          lastModified: Date.now(),
        });
        placeAudioWhenReady(addFiles([file]), 'voice', startSec);
      };
      rec.current = { recorder, stream, startSec };
      player.setMuted(true);
      recorder.start(1000);
      player.play();
      setSeconds(0);
      setRecording(true);
    } catch (err) {
      setError(`Can't record: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={BTN}
        onClick={() => setMenu((m) => !m)}
        disabled={recording}
        aria-expanded={menu}
        data-testid="add-music"
      >
        ♪ Add music
      </button>
      {recording ? (
        <button
          type="button"
          className={`${BTN} bg-red-700 text-white`}
          onClick={stop}
          data-testid="record-voice"
        >
          ■ Stop recording ({seconds}s)
        </button>
      ) : (
        <button
          type="button"
          className={BTN}
          onClick={() => void start()}
          disabled={!player || typeof MediaRecorder === 'undefined'}
          data-testid="record-voice"
        >
          🎙 Record voice
        </button>
      )}
      {menu && (
        <div className="flex w-full flex-wrap gap-2" role="menu" data-testid="music-menu">
          <button
            type="button"
            role="menuitem"
            className={BTN}
            onClick={() => {
              setMenu(false);
              input.current?.click();
            }}
          >
            From my files…
          </button>
          {BUILTIN_TRACKS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              className={BTN}
              onClick={() => {
                setMenu(false);
                void builtinTrackFile(t.id).then(
                  (file) => placeAudioWhenReady(addFiles([file]), 'music', 0),
                  (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
                );
              }}
            >
              ♪ {t.name}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="w-full text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
      <input
        ref={input}
        type="file"
        accept="audio/*"
        hidden
        data-testid="music-input"
        onChange={(e) => {
          if (e.target.files) placeAudioWhenReady(addFiles(e.target.files), 'music', 0);
          e.target.value = '';
        }}
      />
    </div>
  );
}
