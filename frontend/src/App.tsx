import { useEffect, useState } from "react";
import { AircraftMap } from "./components/AircraftMap.js";
import { AircraftDetailPanel } from "./components/AircraftDetailPanel.js";
import { AuthPanel } from "./components/AuthPanel.js";
import { useAircraftFeed } from "./lib/useAircraftFeed.js";
import { api, type CurrentUser } from "./lib/api.js";

export default function App() {
  const { aircraft, connected } = useAircraftFeed();
  const [selectedIcao24, setSelectedIcao24] = useState<string | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null));
  }, []);

  return (
    <div className="relative h-screen w-screen">
      <AircraftMap aircraft={aircraft} onSelect={setSelectedIcao24} />

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
    </div>
  );
}
