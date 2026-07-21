import { useEffect, useState } from "react";
import { AircraftMap } from "./components/AircraftMap.js";
import { AircraftDetailPanel } from "./components/AircraftDetailPanel.js";
import { AuthPanel } from "./components/AuthPanel.js";
import { NeighborhoodAnalyticsPanel } from "./components/NeighborhoodAnalyticsPanel.js";
import { useAircraftFeed } from "./lib/useAircraftFeed.js";
import { api, type CurrentUser } from "./lib/api.js";

export default function App() {
  const { aircraft, connected } = useAircraftFeed();
  const [selectedIcao24, setSelectedIcao24] = useState<string | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [showNoisePanel, setShowNoisePanel] = useState(false);

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null));
  }, []);

  return (
    <div className="relative h-screen w-screen">
      <AircraftMap aircraft={aircraft} selectedIcao24={selectedIcao24} onSelect={setSelectedIcao24} />

      <AuthPanel user={user} onAuthChange={setUser} />

      {selectedIcao24 && (
        <AircraftDetailPanel
          icao24={selectedIcao24}
          live={aircraft.get(selectedIcao24)}
          onClose={() => setSelectedIcao24(null)}
        />
      )}

      <div className="absolute bottom-4 left-4 rounded bg-white/90 px-3 py-1 text-xs text-gray-700 shadow">
        {connected ? "🟢 live" : "🔴 reconnecting…"} · {aircraft.size} aircraft
      </div>

      {showNoisePanel ? (
        <NeighborhoodAnalyticsPanel onClose={() => setShowNoisePanel(false)} />
      ) : (
        <button
          onClick={() => setShowNoisePanel(true)}
          className="absolute bottom-12 left-4 rounded-lg bg-white/95 px-3 py-2 text-sm shadow-lg backdrop-blur hover:bg-white"
        >
          📊 Neighborhood noise
        </button>
      )}
    </div>
  );
}
