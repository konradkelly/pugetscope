import { AIRCRAFT_CLASSES, AIRCRAFT_CLASS_ICON, AIRCRAFT_CLASS_LABEL, AIRCRAFT_CLASS_SIZE } from "../lib/aircraftCategory.js";
import { Panel, PanelHeader } from "./Panel.js";

interface Props {
  onClose: () => void;
}

export function AircraftLegend({ onClose }: Props) {
  return (
    <Panel className="w-full p-3 text-sm sm:w-56">
      <PanelHeader title="Aircraft type" onClose={onClose} />
      <ul className="mt-2 flex flex-col gap-1.5">
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
    </Panel>
  );
}
