import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { audioItemsOf, itemEnd } from '../../core/audioTrack';
import type { AudioItem, AudioKind, Project } from '../../core/project';
import { itemName, useMediaStore } from '../../state/mediaStore';
import { useProjectStore } from '../../state/projectStore';

export const AUDIO_ROW_HEIGHT = 36;
const ROWS: { kind: AudioKind; label: string; color: string }[] = [
  { kind: 'music', label: 'Music', color: 'bg-indigo-700' },
  { kind: 'voice', label: 'Voice', color: 'bg-teal-700' },
];

export const audioRowsHeight = (p: Project) =>
  audioItemsOf(p).length > 0 ? ROWS.length * (AUDIO_ROW_HEIGHT + 4) : 0;

/**
 * Music and voice-over rows under the clips. Tap an item to select it; drag it sideways to move
 * it in time (its own touch handling, so the timeline doesn't scroll meanwhile).
 */
export function AudioRows(props: { project: Project; pps: number; pad: number; top: number }) {
  const { project, pps, pad, top } = props;
  const videoEnd = project.clips.reduce((t, c) => t + c.outSec - c.inSec, 0);
  const selected = useProjectStore((s) => s.selectedAudioId);
  const items = audioItemsOf(project);
  if (items.length === 0) return null;
  return (
    <>
      {ROWS.map((row, r) => (
        <div
          key={row.kind}
          className="absolute right-0 left-0"
          style={{ top: top + r * (AUDIO_ROW_HEIGHT + 4), height: AUDIO_ROW_HEIGHT }}
          data-track="1"
          data-testid={`audio-row-${row.kind}`}
        >
          {items
            .filter((a) => a.kind === row.kind)
            .map((a) => (
              <AudioBlock
                key={a.id}
                item={a}
                left={pad + a.startSec * pps}
                width={Math.max(8, (itemEnd(a, videoEnd) - a.startSec) * pps)}
                pps={pps}
                color={row.color}
                selected={a.id === selected}
              />
            ))}
        </div>
      ))}
    </>
  );
}

function AudioBlock(props: {
  item: AudioItem;
  left: number;
  width: number;
  pps: number;
  color: string;
  selected: boolean;
}) {
  const { item } = props;
  const name = useMediaStore((s) => {
    const it = s.items.find((i) => i.id === item.mediaId);
    return it ? itemName(it) : '';
  });
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const [dx, setDx] = useState(0);

  const down = (e: ReactPointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, moved: false };
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const delta = e.clientX - d.x;
    if (Math.abs(delta) > 4) d.moved = true;
    if (d.moved) setDx(delta);
  };
  const up = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    e.stopPropagation();
    const s = useProjectStore.getState();
    if (d.moved) s.moveAudio(item.id, item.startSec + (e.clientX - d.x) / props.pps);
    s.selectAudio(item.id);
    setDx(0);
  };

  return (
    <div
      className={`absolute top-0 h-full overflow-hidden rounded-md px-2 text-xs leading-9 text-white ${props.color} ${
        props.selected ? 'ring-2 ring-yellow-400' : ''
      } ${item.audio?.muted ? 'opacity-50' : ''}`}
      style={{
        left: props.left,
        width: props.width,
        transform: dx ? `translateX(${dx}px)` : undefined,
        touchAction: 'none',
      }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        drag.current = null;
        setDx(0);
      }}
      onClick={(e) => e.stopPropagation()}
      data-testid="audio-item"
      data-kind={item.kind}
      data-start={item.startSec}
    >
      {item.kind === 'music' ? '♪ ' : '🎙 '}
      {name}
    </div>
  );
}
