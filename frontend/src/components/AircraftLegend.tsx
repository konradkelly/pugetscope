import { AIRCRAFT_CLASSES, AIRCRAFT_CLASS_ICON, AIRCRAFT_CLASS_LABEL, AIRCRAFT_CLASS_SIZE } from "../lib/aircraftCategory.js";

interface Props {
  onClose: () => void;
}

export function AircraftLegend({ onClose }: Props) {
  return (
    <div className="w-56 rounded-lg bg-white/95 p-3 text-sm shadow-lg backdrop-blur">
      <div className="mb-2 flex items-center justify-between gap-4">
        <span className="font-medium text-gray-700">Aircraft type</span>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
          ✕
        </button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {AIRCRAFT_CLASSES.map((cls) => (
          <li key={cls} className="flex items-center gap-2 text-gray-700">
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center text-sky-600"
              // Static, internally-defined markup (aircraftCategory.ts) — not user input.
              dangerouslySetInnerHTML={{
                __html: `<svg width="${AIRCRAFT_CLASS_SIZE[cls]}" height="${AIRCRAFT_CLASS_SIZE[cls]}" viewBox="0 0 24 24" fill="currentColor">${AIRCRAFT_CLASS_ICON[cls]}</svg>`,
              }}
            />
            {AIRCRAFT_CLASS_LABEL[cls]}
          </li>
        ))}
      </ul>
    </div>
  );
}
