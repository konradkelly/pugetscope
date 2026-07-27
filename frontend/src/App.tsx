import { useEffect, useState } from "react";
import { Bell, Circle, ClipboardList, Plane, TicketsPlane, TrendingUp, Volume2 } from "lucide-react";
import { AircraftMap } from "./components/AircraftMap.js";
import { AircraftDetailPanel } from "./components/AircraftDetailPanel.js";
import { AircraftLegend } from "./components/AircraftLegend.js";
import { AirportBoardPanel } from "./components/AirportBoardPanel.js";
import { AlertsPanel } from "./components/AlertsPanel.js";
import { AuthPanel } from "./components/AuthPanel.js";
import { FlowBadge } from "./components/FlowBadge.js";
import { IconRail, type RailItem } from "./components/IconRail.js";
import { NeighborhoodAnalyticsPanel, ZIP_OPTIONS } from "./components/NeighborhoodAnalyticsPanel.js";
import { TrafficVolumePanel } from "./components/TrafficVolumePanel.js";
import { SpottingLogPanel } from "./components/SpottingLogPanel.js";
import { useAircraftFeed } from "./lib/useAircraftFeed.js";
import { useUrlRoute } from "./lib/useUrlRoute.js";
import { api, type CurrentUser } from "./lib/api.js";

type RailPanelId = "legend" | "traffic" | "board" | "noise" | "spotting" | "alerts";

export default function App() {
  const { aircraft, connected } = useAircraftFeed();
  const { route, navigate } = useUrlRoute();
  const [selectedIcao24, setSelectedIcao24] = useState<string | null>(
    route.type === "aircraft" ? route.icao24 : null,
  );
  const [user, setUser] = useState<CurrentUser | null>(null);
  // Legend open by default so marker size/shape is explained on first load —
  // unless the page was loaded from a shared neighborhood link, in which case
  // that's what the visitor came to see. Everything else starts collapsed,
  // same as before this was a rail.
  const [activeRailPanel, setActiveRailPanel] = useState<RailPanelId | null>(
    route.type === "neighborhood" ? "noise" : "legend",
  );
  // Tracked independently of the URL so the neighborhood panel's current zip
  // survives switching away and back (e.g. to look at an aircraft) — the URL
  // itself can only represent one of {aircraft, neighborhood} at a time,
  // aircraft taking priority.
  const [neighborhoodZip, setNeighborhoodZip] = useState<string>(
    route.type === "neighborhood" ? route.zip : ZIP_OPTIONS[0].zip,
  );
  const [pinDropArmed, setPinDropArmed] = useState(false);
  const [droppedPin, setDroppedPin] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null));
  }, []);

  const railItems: RailItem[] = [
    { id: "legend", icon: Plane, label: "Aircraft type legend" },
    { id: "traffic", icon: TrendingUp, label: "Traffic volume" },
    { id: "board", icon: TicketsPlane, label: "Airport board" },
    { id: "noise", icon: Volume2, label: "Neighborhood noise" },
    // Always visible, unlike the spotting log — this is specifically the
    // logged-out-facing engagement feature (device-scoped, no account).
    { id: "alerts", icon: Bell, label: "Alerts" },
    ...(user ? [{ id: "spotting", icon: ClipboardList, label: "My spotting log" } as const] : []),
  ];

  function selectAircraft(icao24: string) {
    setSelectedIcao24(icao24);
    navigate(`/aircraft/${icao24}`);
  }

  function closeAircraftDetail() {
    setSelectedIcao24(null);
    navigate(activeRailPanel === "noise" ? `/neighborhood/${neighborhoodZip}` : "/");
  }

  function toggleRailPanel(id: string) {
    setActiveRailPanel((current) => {
      const next = current === id ? null : (id as RailPanelId);
      // An open aircraft detail panel keeps the URL pointed at that aircraft
      // regardless of which rail panel is also open alongside it.
      if (!selectedIcao24) {
        navigate(next === "noise" ? `/neighborhood/${neighborhoodZip}` : "/");
      }
      // Leaving the alerts panel mid-pin-drop should also disarm it rather
      // than leaving the map stuck in crosshair mode with no visible panel.
      if (next !== "alerts") setPinDropArmed(false);
      return next;
    });
  }

  function changeNeighborhoodZip(zip: string) {
    setNeighborhoodZip(zip);
    if (!selectedIcao24) navigate(`/neighborhood/${zip}`);
  }

  return (
    <div className="relative h-screen w-screen">
      <AircraftMap
        aircraft={aircraft}
        selectedIcao24={selectedIcao24}
        onSelect={selectAircraft}
        pinDropMode={pinDropArmed}
        onPinDrop={(lngLat) => {
          setDroppedPin(lngLat);
          setPinDropArmed(false);
        }}
        pendingPin={droppedPin}
      />

      <div className="absolute left-4 top-4">
        <AuthPanel user={user} onAuthChange={setUser} />
      </div>

      {selectedIcao24 && (
        <AircraftDetailPanel
          icao24={selectedIcao24}
          live={aircraft.get(selectedIcao24)}
          user={user}
          onClose={closeAircraftDetail}
        />
      )}

      <div className="absolute bottom-4 left-4 flex items-end gap-2">
        <div className="flex items-center gap-1.5 rounded bg-white/90 px-3 py-1 text-xs text-gray-700 shadow">
          <Circle size={8} className={connected ? "fill-green-500 text-green-500" : "fill-red-500 text-red-500"} />
          {connected ? "live" : "reconnecting…"} · {aircraft.size} aircraft
        </div>
        <FlowBadge />
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
          {activeRailPanel === "board" && (
            <AirportBoardPanel onClose={() => setActiveRailPanel(null)} />
          )}
          {activeRailPanel === "noise" && (
            <NeighborhoodAnalyticsPanel
              onClose={() => toggleRailPanel("noise")}
              initialZip={neighborhoodZip}
              onZipChange={changeNeighborhoodZip}
            />
          )}
          {activeRailPanel === "alerts" && (
            <AlertsPanel
              onClose={() => toggleRailPanel("alerts")}
              pinDropArmed={pinDropArmed}
              onArmPinDrop={() => setPinDropArmed(true)}
              droppedPin={droppedPin}
              onClearDroppedPin={() => setDroppedPin(null)}
            />
          )}
          {activeRailPanel === "spotting" && user && (
            <SpottingLogPanel onClose={() => setActiveRailPanel(null)} />
          )}
        </div>
      )}
    </div>
  );
}
