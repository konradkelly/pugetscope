import { useEffect, useState } from "react";
import { Circle, ClipboardList, Plane, TrendingUp, Volume2 } from "lucide-react";
import { AircraftMap } from "./components/AircraftMap.js";
import { AircraftDetailPanel } from "./components/AircraftDetailPanel.js";
import { AircraftLegend } from "./components/AircraftLegend.js";
import { AuthPanel } from "./components/AuthPanel.js";
import { IconRail, type RailItem } from "./components/IconRail.js";
import { NeighborhoodAnalyticsPanel } from "./components/NeighborhoodAnalyticsPanel.js";
import { TrafficVolumePanel } from "./components/TrafficVolumePanel.js";
import { SpottingLogPanel } from "./components/SpottingLogPanel.js";
import { useAircraftFeed } from "./lib/useAircraftFeed.js";
import { api, type CurrentUser } from "./lib/api.js";

type RailPanelId = "legend" | "traffic" | "noise" | "spotting";

export default function App() {
  const { aircraft, connected } = useAircraftFeed();
  const [selectedIcao24, setSelectedIcao24] = useState<string | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  // Legend open by default so marker size/shape is explained on first load;
  // everything else starts collapsed, same as before this was a rail.
  const [activeRailPanel, setActiveRailPanel] = useState<RailPanelId | null>("legend");

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null));
  }, []);

  const railItems: RailItem[] = [
    { id: "legend", icon: Plane, label: "Aircraft type legend" },
    { id: "traffic", icon: TrendingUp, label: "Traffic volume" },
    { id: "noise", icon: Volume2, label: "Neighborhood noise" },
    ...(user ? [{ id: "spotting", icon: ClipboardList, label: "My spotting log" } as const] : []),
  ];

  function toggleRailPanel(id: string) {
    setActiveRailPanel((current) => (current === id ? null : (id as RailPanelId)));
  }

  return (
    <div className="relative h-screen w-screen">
      <AircraftMap aircraft={aircraft} selectedIcao24={selectedIcao24} onSelect={setSelectedIcao24} />

      <div className="absolute left-4 top-4">
        <AuthPanel user={user} onAuthChange={setUser} />
      </div>

      {selectedIcao24 && (
        <AircraftDetailPanel
          icao24={selectedIcao24}
          live={aircraft.get(selectedIcao24)}
          user={user}
          onClose={() => setSelectedIcao24(null)}
        />
      )}

      <div className="absolute bottom-4 left-4 flex items-center gap-1.5 rounded bg-white/90 px-3 py-1 text-xs text-gray-700 shadow">
        <Circle size={8} className={connected ? "fill-green-500 text-green-500" : "fill-red-500 text-red-500"} />
        {connected ? "live" : "reconnecting…"} · {aircraft.size} aircraft
      </div>

      {/* Single dock replacing the four independently-positioned corner
          toggles (legend/traffic/noise/spotting log) this app used to have —
          see docs/SPEC.md §6. Bottom-anchored (like the old per-panel corner
          buttons were) and capped well short of the viewport top so even the
          tallest panel (traffic volume) can't grow up into AuthPanel's space
          — vertical centering was tried first and didn't hold up there. */}
      <div className="absolute bottom-12 left-4">
        <IconRail items={railItems} activeId={activeRailPanel} onSelect={toggleRailPanel} />
      </div>

      {activeRailPanel && (
        <div className="absolute bottom-12 left-20 max-h-[65vh] overflow-y-auto">
          {activeRailPanel === "legend" && (
            <AircraftLegend onClose={() => setActiveRailPanel(null)} />
          )}
          {activeRailPanel === "traffic" && (
            <TrafficVolumePanel onClose={() => setActiveRailPanel(null)} />
          )}
          {activeRailPanel === "noise" && (
            <NeighborhoodAnalyticsPanel onClose={() => setActiveRailPanel(null)} />
          )}
          {activeRailPanel === "spotting" && user && (
            <SpottingLogPanel onClose={() => setActiveRailPanel(null)} />
          )}
        </div>
      )}
    </div>
  );
}
