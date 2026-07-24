import { useEffect, useState } from "react";
import { Circle, ClipboardList, Plane, TrendingUp, Volume2 } from "lucide-react";
import { AircraftMap } from "./components/AircraftMap.js";
import { AircraftDetailPanel } from "./components/AircraftDetailPanel.js";
import { AircraftLegend } from "./components/AircraftLegend.js";
import { AuthPanel } from "./components/AuthPanel.js";
import { NeighborhoodAnalyticsPanel } from "./components/NeighborhoodAnalyticsPanel.js";
import { TrafficVolumePanel } from "./components/TrafficVolumePanel.js";
import { SpottingLogPanel } from "./components/SpottingLogPanel.js";
import { useAircraftFeed } from "./lib/useAircraftFeed.js";
import { api, type CurrentUser } from "./lib/api.js";

export default function App() {
  const { aircraft, connected } = useAircraftFeed();
  const [selectedIcao24, setSelectedIcao24] = useState<string | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [showNoisePanel, setShowNoisePanel] = useState(false);
  const [showTrafficPanel, setShowTrafficPanel] = useState(false);
  const [showSpottingLog, setShowSpottingLog] = useState(false);
  const [showLegend, setShowLegend] = useState(true);

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null));
  }, []);

  return (
    <div className="relative h-screen w-screen">
      <AircraftMap aircraft={aircraft} selectedIcao24={selectedIcao24} onSelect={setSelectedIcao24} />

      {/* Stacked in normal flow (not each independently `absolute`-positioned)
          so the spotting-log toggle never overlaps AuthPanel regardless of
          whether it's rendering the short logged-in chip or the taller
          login/signup form. */}
      <div className="absolute left-4 top-4 flex flex-col items-start gap-2">
        <AuthPanel user={user} onAuthChange={setUser} />

        {user &&
          (showSpottingLog ? (
            <SpottingLogPanel onClose={() => setShowSpottingLog(false)} />
          ) : (
            <button
              onClick={() => setShowSpottingLog(true)}
              className="flex items-center gap-1.5 rounded-lg bg-white/95 px-3 py-2 text-sm shadow-lg backdrop-blur hover:bg-white"
            >
              <ClipboardList size={16} /> My spotting log
            </button>
          ))}
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

      {showNoisePanel ? (
        <NeighborhoodAnalyticsPanel onClose={() => setShowNoisePanel(false)} />
      ) : (
        <button
          onClick={() => setShowNoisePanel(true)}
          className="absolute bottom-12 left-4 flex items-center gap-1.5 rounded-lg bg-white/95 px-3 py-2 text-sm shadow-lg backdrop-blur hover:bg-white"
        >
          <Volume2 size={16} /> Neighborhood noise
        </button>
      )}

      {/* Stacked (see the top-left comment above) so the legend's height
          doesn't collide with the traffic volume toggle/panel below it. */}
      <div className="absolute bottom-4 right-4 flex flex-col items-end gap-2">
        {showTrafficPanel ? (
          <TrafficVolumePanel onClose={() => setShowTrafficPanel(false)} />
        ) : (
          <button
            onClick={() => setShowTrafficPanel(true)}
            className="flex items-center gap-1.5 rounded-lg bg-white/95 px-3 py-2 text-sm shadow-lg backdrop-blur hover:bg-white"
          >
            <TrendingUp size={16} /> Traffic volume
          </button>
        )}

        {showLegend ? (
          <AircraftLegend onClose={() => setShowLegend(false)} />
        ) : (
          <button
            onClick={() => setShowLegend(true)}
            className="flex items-center gap-1.5 rounded-lg bg-white/95 px-3 py-2 text-sm shadow-lg backdrop-blur hover:bg-white"
          >
            <Plane size={16} /> Legend
          </button>
        )}
      </div>
    </div>
  );
}
