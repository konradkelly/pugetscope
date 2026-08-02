import { useEffect, useState } from "react";
import { Bell, Circle, ClipboardList, History, Newspaper, Plane, TicketsPlane, TrendingUp, User, Volume2 } from "lucide-react";
import { AircraftMap } from "./components/AircraftMap.js";
import { AircraftDetailPanel } from "./components/AircraftDetailPanel.js";
import { AircraftLegend } from "./components/AircraftLegend.js";
import { AirportBoardPanel, AIRPORT_OPTIONS } from "./components/AirportBoardPanel.js";
import { AlertsPanel } from "./components/AlertsPanel.js";
import { AuthPanel } from "./components/AuthPanel.js";
import { DigestPanel } from "./components/DigestPanel.js";
import { FlowBadge } from "./components/FlowBadge.js";
import { IconRail, type RailItem } from "./components/IconRail.js";
import { NeighborhoodAnalyticsPanel, ZIP_OPTIONS } from "./components/NeighborhoodAnalyticsPanel.js";
import { ReplayScrubber } from "./components/ReplayScrubber.js";
import { TrafficVolumePanel } from "./components/TrafficVolumePanel.js";
import { SpottingLogPanel } from "./components/SpottingLogPanel.js";
import { useAircraftFeed } from "./lib/useAircraftFeed.js";
import { useReplayPlayback } from "./lib/useReplayPlayback.js";
import { useUrlRoute } from "./lib/useUrlRoute.js";
import { getPageMeta } from "./lib/pageMeta.js";
import { api, type CurrentUser } from "./lib/api.js";

type RailPanelId = "legend" | "traffic" | "board" | "noise" | "digest" | "spotting" | "alerts" | "replay" | "auth";

// Mirrors ingestion/src/index.ts's todayLA()/yesterdayLA() and
// ingestion/src/generateDigest.ts's copy — each service keeps its own, per
// this repo's no-shared-package convention. The rail icon always links to
// yesterday's digest; a direct /digest/:date link shows whatever date is in
// the URL instead (see the digestDate calc in App() below).
function yesterdayLA(): string {
  const todayLA = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const [y, m, d] = todayLA.split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  return `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, "0")}-${String(yesterday.getUTCDate()).padStart(2, "0")}`;
}

export default function App() {
  const { aircraft: liveAircraft, connected } = useAircraftFeed();
  const { route, navigate } = useUrlRoute();
  const [selectedIcao24, setSelectedIcao24] = useState<string | null>(
    route.type === "aircraft" ? route.icao24 : null,
  );
  const [user, setUser] = useState<CurrentUser | null>(null);
  // Legend open by default so marker size/shape is explained on first load —
  // unless the page was loaded from a shared neighborhood/airport link, in
  // which case that's what the visitor came to see. Everything else starts
  // collapsed, same as before this was a rail.
  const [activeRailPanel, setActiveRailPanel] = useState<RailPanelId | null>(
    route.type === "neighborhood"
      ? "noise"
      : route.type === "airport"
        ? "board"
        : route.type === "digest"
          ? "digest"
          : "legend",
  );
  // Tracked independently of the URL so the neighborhood panel's current zip
  // survives switching away and back (e.g. to look at an aircraft) — the URL
  // itself can only represent one of {aircraft, neighborhood, airport} at a
  // time, aircraft taking priority.
  const [neighborhoodZip, setNeighborhoodZip] = useState<string>(
    route.type === "neighborhood" ? route.zip : ZIP_OPTIONS[0].zip,
  );
  // Same idea as neighborhoodZip, for the airport board's currently-selected field.
  const [boardIcao, setBoardIcao] = useState<string>(
    route.type === "airport" ? route.icao : AIRPORT_OPTIONS[0].icao,
  );
  // Not stateful like neighborhoodZip/boardIcao: the rail icon always points
  // at yesterday's digest, so this is recomputed from the current route
  // rather than remembered — a direct /digest/:date link shows that date,
  // everything else (including reopening via the rail) shows yesterday.
  const digestDate = route.type === "digest" ? route.date : yesterdayLA();
  const [pinDropArmed, setPinDropArmed] = useState(false);
  const [droppedPin, setDroppedPin] = useState<{ lat: number; lng: number } | null>(null);

  // Replay swaps the map's whole data source (see docs/SPEC.md §16) rather
  // than opening an overlay panel, but still rides the same exclusive
  // activeRailPanel selection so opening it closes whatever else was open.
  const replayMode = activeRailPanel === "replay";
  const replay = useReplayPlayback(replayMode);
  const aircraft = replayMode ? replay.aircraft : liveAircraft;

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null));
  }, []);

  // Per-route title/description so each deep-linkable page (airport board,
  // neighborhood, aircraft) is distinguishable in search results and browser
  // tabs, not just the site-wide default from index.html.
  useEffect(() => {
    const meta = getPageMeta(route);
    document.title = meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", meta.description);
  }, [route]);

  const railItems: RailItem[] = [
    { id: "legend", icon: Plane, label: "Aircraft type legend" },
    { id: "traffic", icon: TrendingUp, label: "Traffic volume" },
    { id: "board", icon: TicketsPlane, label: "Airport board" },
    { id: "noise", icon: Volume2, label: "Neighborhood noise" },
    { id: "digest", icon: Newspaper, label: "Daily digest" },
    { id: "replay", icon: History, label: "Replay" },
    // Always visible, unlike the spotting log — this is specifically the
    // logged-out-facing engagement feature (device-scoped, no account).
    { id: "alerts", icon: Bell, label: "Alerts" },
    ...(user ? [{ id: "spotting", icon: ClipboardList, label: "My spotting log" } as const] : []),
    { id: "auth", icon: User, label: user ? user.email : "Log in / sign up", badge: !!user },
  ];

  // Shared by closeAircraftDetail/toggleRailPanel below — the URL for
  // whichever rail panel is (about to be) active, home otherwise.
  function pathForRailPanel(panel: RailPanelId | null): string {
    if (panel === "noise") return `/neighborhood/${neighborhoodZip}`;
    if (panel === "board") return `/airport/${boardIcao}`;
    if (panel === "digest") return `/digest/${yesterdayLA()}`;
    return "/";
  }

  function selectAircraft(icao24: string) {
    setSelectedIcao24(icao24);
    navigate(`/aircraft/${icao24}`);
  }

  function closeAircraftDetail() {
    setSelectedIcao24(null);
    navigate(pathForRailPanel(activeRailPanel));
  }

  function toggleRailPanel(id: string) {
    setActiveRailPanel((current) => {
      const next = current === id ? null : (id as RailPanelId);
      // An open aircraft detail panel keeps the URL pointed at that aircraft
      // regardless of which rail panel is also open alongside it.
      if (!selectedIcao24) navigate(pathForRailPanel(next));
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

  function changeBoardIcao(icao: string) {
    setBoardIcao(icao);
    if (!selectedIcao24) navigate(`/airport/${icao}`);
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

      {selectedIcao24 && (
        <div className="fixed inset-x-0 bottom-14 z-10 max-h-[70vh] overflow-y-auto sm:absolute sm:inset-x-auto sm:right-4 sm:top-4 sm:bottom-auto sm:left-auto sm:z-auto sm:max-h-none">
          <AircraftDetailPanel
            icao24={selectedIcao24}
            live={aircraft.get(selectedIcao24)}
            user={user}
            onClose={closeAircraftDetail}
            replay={replayMode}
          />
        </div>
      )}

      {/* z-0, not z-20 like the tab bar below — this cluster should sit
          *behind* an open sheet (z-10) so the sheet's opaque card hides it
          entirely, not float on top of the sheet's own content. */}
      <div className="fixed bottom-16 left-4 z-0 flex items-end gap-2 sm:absolute sm:bottom-4 sm:z-auto">
        <div className="flex items-center gap-1.5 rounded bg-white/90 px-3 py-1 text-xs text-gray-700 shadow">
          <Circle
            size={8}
            className={
              replayMode
                ? "fill-amber-500 text-amber-500"
                : connected
                  ? "fill-green-500 text-green-500"
                  : "fill-red-500 text-red-500"
            }
          />
          {replayMode ? "replay" : connected ? "live" : "reconnecting…"} · {aircraft.size} aircraft
        </div>
        {!replayMode && <FlowBadge />}
      </div>

      {/* Single dock replacing the four independently-positioned corner
          toggles (legend/traffic/noise/spotting log) this app used to have,
          plus the standalone top-left AuthPanel — see docs/SPEC.md §6.
          Bottom-anchored (like the old per-panel corner buttons were) and
          capped well short of the viewport top so even the tallest panel
          (traffic volume) has room to grow — vertical centering was tried
          first and didn't hold up there. */}
      <div className="fixed inset-x-0 bottom-0 z-20 sm:absolute sm:inset-x-auto sm:bottom-12 sm:left-4 sm:z-auto">
        <IconRail items={railItems} activeId={activeRailPanel} onSelect={toggleRailPanel} />
      </div>

      {activeRailPanel && (
        <div className="fixed inset-x-0 bottom-14 z-10 max-h-[70vh] overflow-y-auto sm:absolute sm:inset-x-auto sm:bottom-12 sm:left-20 sm:z-auto sm:max-h-[65vh]">
          {activeRailPanel === "legend" && (
            <AircraftLegend onClose={() => setActiveRailPanel(null)} />
          )}
          {activeRailPanel === "traffic" && (
            <TrafficVolumePanel onClose={() => setActiveRailPanel(null)} />
          )}
          {activeRailPanel === "board" && (
            <AirportBoardPanel
              onClose={() => toggleRailPanel("board")}
              initialAirport={boardIcao}
              onAirportChange={changeBoardIcao}
            />
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
          {activeRailPanel === "digest" && (
            <DigestPanel date={digestDate} onClose={() => toggleRailPanel("digest")} />
          )}
          {activeRailPanel === "replay" && (
            <ReplayScrubber
              bounds={replay.bounds}
              currentMs={replay.currentMs}
              playing={replay.playing}
              speed={replay.speed}
              error={replay.error}
              onSeek={replay.seek}
              onPlayPause={() => replay.setPlaying(!replay.playing)}
              onSpeedChange={replay.setSpeed}
              onClose={() => toggleRailPanel("replay")}
            />
          )}
          {activeRailPanel === "auth" && (
            <AuthPanel user={user} onAuthChange={setUser} onClose={() => toggleRailPanel("auth")} />
          )}
        </div>
      )}
    </div>
  );
}
