import { BASE_STYLES, type BaseStyleId } from "../lib/basemapStyles.js";
import { Panel, PanelHeader } from "./Panel.js";

interface Props {
  baseStyle: BaseStyleId;
  terrain: boolean;
  onBaseStyleChange: (id: BaseStyleId) => void;
  onTerrainChange: (enabled: boolean) => void;
  onClose: () => void;
}

export function BasemapPanel({ baseStyle, terrain, onBaseStyleChange, onTerrainChange, onClose }: Props) {
  const activeStyle = BASE_STYLES.find((s) => s.id === baseStyle);
  const terrainDisabled = activeStyle ? !activeStyle.supportsTerrain : false;

  return (
    <Panel className="w-full p-3 text-sm sm:w-56">
      <PanelHeader title="Basemap" onClose={onClose} />
      <ul className="mt-2 flex flex-col gap-1">
        {BASE_STYLES.map((option) => (
          <li key={option.id}>
            <label className="flex cursor-pointer items-center gap-2 py-0.5 text-gray-700">
              <input
                type="radio"
                name="basemap-style"
                checked={baseStyle === option.id}
                onChange={() => onBaseStyleChange(option.id)}
              />
              {option.label}
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-2 border-t border-gray-100 pt-2">
        <label
          className={`flex items-center gap-2 ${terrainDisabled ? "text-gray-400" : "cursor-pointer text-gray-700"}`}
        >
          <input
            type="checkbox"
            checked={terrain}
            disabled={terrainDisabled}
            onChange={(e) => onTerrainChange(e.target.checked)}
          />
          Terrain relief
        </label>
        {terrainDisabled && (
          <p className="mt-1 text-xs text-gray-400">Topographic already includes its own relief shading.</p>
        )}
      </div>
    </Panel>
  );
}
