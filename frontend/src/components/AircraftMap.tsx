import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FeatureCollection } from "geojson";
import { PUGET_SOUND_CENTER, PUGET_SOUND_DEFAULT_ZOOM } from "../lib/config.js";
import type { AircraftByIcao } from "../lib/useAircraftFeed.js";
import { AIRCRAFT_CLASS_ICON, AIRCRAFT_CLASS_SIZE, classifyAircraft, type AircraftClass } from "../lib/aircraftCategory.js";

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
  selectedIcao24: string | null;
  onSelect: (icao24: string) => void;
}

const TRAIL_SOURCE_ID = "flight-path";
const TRAIL_MAX_POINTS = 300;
const MARKER_COLOR = "text-sky-600";
const SELECTED_MARKER_COLOR = "text-violet-600";

// Size/shape vary by ADS-B category (see aircraftCategory.ts); color still
// carries selection state, same as before this was added.
function markerSvgMarkup(cls: AircraftClass): string {
  const size = AIRCRAFT_CLASS_SIZE[cls];
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" class="${MARKER_COLOR} drop-shadow">
      ${AIRCRAFT_CLASS_ICON[cls]}
    </svg>
  `;
}

function createMarkerElement(cls: AircraftClass): HTMLDivElement {
  const el = document.createElement("div");
  el.innerHTML = markerSvgMarkup(cls);
  el.style.cursor = "pointer";
  return el;
}

function emptyLineCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

export function AircraftMap({ aircraft, selectedIcao24, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  // Category rarely if ever changes for a given aircraft, but it can arrive
  // a beat after the marker is first created (first update after "unknown").
  // Tracked separately from the marker so we only touch innerHTML when the
  // class actually changes, rather than re-rendering the SVG every frame.
  const markerClassRef = useRef<Map<string, AircraftClass>>(new Map());
  // Positions observed client-side since each aircraft was first seen — the
  // feed only carries current state, so there's no server-side history to
  // draw the trail from.
  const trailsRef = useRef<Map<string, [number, number][]>>(new Map());

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: PUGET_SOUND_CENTER,
      zoom: PUGET_SOUND_DEFAULT_ZOOM,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      map.addSource(TRAIL_SOURCE_ID, { type: "geojson", data: emptyLineCollection() });
      map.addLayer({
        id: TRAIL_SOURCE_ID,
        type: "line",
        source: TRAIL_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#7c3aed", "line-width": 2, "line-opacity": 0.7 },
      });
    });

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
    const markerClasses = markerClassRef.current;
    const trails = trailsRef.current;
    const seen = new Set<string>();

    for (const [icao24, state] of aircraft) {
      if (state.latitude === null || state.longitude === null) continue;
      seen.add(icao24);

      const cls = classifyAircraft(state);
      let marker = markers.get(icao24);
      if (!marker) {
        const el = createMarkerElement(cls);
        el.addEventListener("click", () => onSelect(icao24));
        // lngLat must be set before addTo() — the marker renders immediately
        // on add and MapLibre has nothing to project otherwise.
        marker = new maplibregl.Marker({ element: el, rotationAlignment: "map" }).setLngLat([
          state.longitude,
          state.latitude,
        ]);
        marker.addTo(map);
        markers.set(icao24, marker);
        markerClasses.set(icao24, cls);
      } else if (markerClasses.get(icao24) !== cls) {
        marker.getElement().innerHTML = markerSvgMarkup(cls);
        markerClasses.set(icao24, cls);
      }

      marker.setLngLat([state.longitude, state.latitude]);
      marker.setRotation(state.trueTrack ?? 0);

      const svg = marker.getElement().querySelector("svg");
      svg?.classList.toggle(SELECTED_MARKER_COLOR, icao24 === selectedIcao24);
      svg?.classList.toggle(MARKER_COLOR, icao24 !== selectedIcao24);

      const trail = trails.get(icao24) ?? [];
      const last = trail[trail.length - 1];
      if (!last || last[0] !== state.longitude || last[1] !== state.latitude) {
        trail.push([state.longitude, state.latitude]);
        if (trail.length > TRAIL_MAX_POINTS) trail.shift();
      }
      trails.set(icao24, trail);
    }

    // remove markers for aircraft no longer in the current snapshot/update
    for (const [icao24, marker] of markers) {
      if (!seen.has(icao24)) {
        marker.remove();
        markers.delete(icao24);
        markerClasses.delete(icao24);
      }
    }

    // drop trails for aircraft that are gone and not the current selection
    for (const icao24 of trails.keys()) {
      if (!seen.has(icao24) && icao24 !== selectedIcao24) trails.delete(icao24);
    }

    const trailSource = map.getSource(TRAIL_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (trailSource) {
      const selectedTrail = selectedIcao24 ? trails.get(selectedIcao24) : undefined;
      trailSource.setData(
        selectedTrail && selectedTrail.length > 1
          ? {
              type: "FeatureCollection",
              features: [
                { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: selectedTrail } },
              ],
            }
          : emptyLineCollection(),
      );
    }
  }, [aircraft, selectedIcao24, onSelect]);

  return <div ref={containerRef} className="h-full w-full" />;
}
