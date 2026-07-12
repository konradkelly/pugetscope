import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { PUGET_SOUND_CENTER, PUGET_SOUND_DEFAULT_ZOOM } from "../lib/config.js";
import type { AircraftByIcao } from "../lib/useAircraftFeed.js";

// Plain OSM raster tiles — see docs/SPEC.md §6 (MapLibre + OpenStreetMap, no vendor lock-in).
const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

interface Props {
  aircraft: AircraftByIcao;
  onSelect: (icao24: string) => void;
}

// Placeholder icon — pending tar1090 icon-set license check (docs/SPEC.md
// §10 open questions). Swap the innerHTML below once that's resolved.
function createMarkerElement(): HTMLDivElement {
  const el = document.createElement("div");
  el.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" class="text-sky-600 drop-shadow">
      <path d="M12 2 L15 14 L22 17 L22 19 L15 17.5 L14 22 L17 23 L17 24 L12 22.5 L7 24 L7 23 L10 22 L9 17.5 L2 19 L2 17 L9 14 Z" />
    </svg>
  `;
  el.style.cursor = "pointer";
  return el;
}

export function AircraftMap({ aircraft, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: PUGET_SOUND_CENTER,
      zoom: PUGET_SOUND_DEFAULT_ZOOM,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const markers = markersRef.current;
    const seen = new Set<string>();

    for (const [icao24, state] of aircraft) {
      if (state.latitude === null || state.longitude === null) continue;
      seen.add(icao24);

      let marker = markers.get(icao24);
      if (!marker) {
        const el = createMarkerElement();
        el.addEventListener("click", () => onSelect(icao24));
        // lngLat must be set before addTo() — the marker renders immediately
        // on add and MapLibre has nothing to project otherwise.
        marker = new maplibregl.Marker({ element: el, rotationAlignment: "map" }).setLngLat([
          state.longitude,
          state.latitude,
        ]);
        marker.addTo(map);
        markers.set(icao24, marker);
      }

      marker.setLngLat([state.longitude, state.latitude]);
      marker.setRotation(state.trueTrack ?? 0);
    }

    // remove markers for aircraft no longer in the current snapshot/update
    for (const [icao24, marker] of markers) {
      if (!seen.has(icao24)) {
        marker.remove();
        markers.delete(icao24);
      }
    }
  }, [aircraft, onSelect]);

  return <div ref={containerRef} className="h-full w-full" />;
}
