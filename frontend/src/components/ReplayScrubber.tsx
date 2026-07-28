import { Pause, Play, X } from "lucide-react";
import type { ReplayBounds } from "../lib/api.js";
import type { ReplaySpeed } from "../lib/useReplayPlayback.js";
import { Panel } from "./Panel.js";

interface Props {
  bounds: ReplayBounds | null;
  currentMs: number | null;
  playing: boolean;
  speed: ReplaySpeed;
  error: string | null;
  onSeek: (ms: number) => void;
  onPlayPause: () => void;
  onSpeedChange: (speed: ReplaySpeed) => void;
  onClose: () => void;
}

const SPEEDS: ReplaySpeed[] = [1, 5, 20];

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function ReplayScrubber({
  bounds,
  currentMs,
  playing,
  speed,
  error,
  onSeek,
  onPlayPause,
  onSpeedChange,
  onClose,
}: Props) {
  const earliestMs = bounds?.earliest ? new Date(bounds.earliest).getTime() : null;
  const latestMs = bounds?.latest ? new Date(bounds.latest).getTime() : null;
  const hasHistory = earliestMs !== null && latestMs !== null && currentMs !== null;

  return (
    <Panel className="w-[560px] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-gray-900">Replay</span>
        <button onClick={onClose} className="shrink-0 text-gray-400 hover:text-gray-700" aria-label="Exit replay">
          <X size={16} />
        </button>
      </div>

      {!hasHistory && (
        <p className="mt-2 text-sm text-gray-400">No position history available yet.</p>
      )}

      {hasHistory && (
        <>
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={onPlayPause}
              aria-label={playing ? "Pause" : "Play"}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sky-600 text-white hover:bg-sky-700"
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>

            <input
              type="range"
              min={earliestMs}
              max={latestMs}
              value={currentMs}
              onChange={(e) => onSeek(Number(e.target.value))}
              className="flex-1 accent-sky-600"
            />

            <div className="flex shrink-0 rounded-md bg-gray-100 p-0.5 text-xs">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => onSpeedChange(s)}
                  className={`rounded px-2 py-1 transition-colors ${
                    speed === s ? "bg-white font-medium text-gray-900 shadow-sm" : "text-gray-500"
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>

          <p className="mt-2 text-center text-xs tabular-nums text-gray-500">
            {formatTimestamp(currentMs)}
          </p>

          {error && (
            <p className="mt-1 text-center text-xs text-red-600">
              Couldn't load this frame ({error}) — showing the last position that loaded.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
