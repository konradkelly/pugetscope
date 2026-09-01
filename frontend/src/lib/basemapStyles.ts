import type { LayerSpecification, RasterDEMSourceSpecification, StyleSpecification } from "maplibre-gl";

export type BaseStyleId = "bright" | "positron" | "liberty" | "dark" | "satellite";

export interface BaseStyleOption {
  id: BaseStyleId;
  label: string;
  style: string | StyleSpecification;
  // False only for "satellite" — real aerial photography already shows
  // actual terrain shading/shadows, so layering the synthetic hillshade
  // overlay on top would just look muddy/redundant (see HILLSHADE_SOURCE_ID
  // below). Was true "topographic" (OpenTopoMap) before that was replaced
  // by satellite imagery for the same reason (§18) — busy contour/vegetation
  // colors made small aircraft markers hard to pick out.
  supportsTerrain: boolean;
}

// Esri World Imagery — free, no API key, CORS open (verified live), sub-
// meter resolution over US metros including Seattle. The standard free
// satellite/aerial basemap almost every open-source map project uses.
// Replaces an earlier OpenTopoMap ("Topographic") option: OpenTopoMap's
// busy contour-line/vegetation coloring made small aircraft markers hard to
// pick out, which satellite's more photographic look addresses better (see
// docs/SPEC.md §18 — paired with a marker outline for guaranteed contrast
// against imagery's own wide color range, not a substitute for it).
// One honest caveat, same spirit as OpenTopoMap's fair-use policy: Esri's
// terms position this free/keyless endpoint for general and evaluation use
// rather than unlimited high-traffic commercial production — accepted as
// reasonable for a low-traffic portfolio project, not a hard blocker.
// Not a style-JSON URL, so this is a minimal inline style object instead:
// one raster source/layer, no sprite/glyphs needed. The attribution string
// is picked up automatically by MapLibre's default AttributionControl (the
// app never sets attributionControl: false), same mechanism that already
// covered OpenTopoMap's requirement.
const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    "esri-world-imagery": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community",
    },
  },
  layers: [{ id: "esri-world-imagery", type: "raster", source: "esri-world-imagery" }],
};

// All four OpenFreeMap style URLs verified live (HTTP 200) — "dark" isn't
// advertised on OpenFreeMap's own homepage (which lists only 3 styles) but
// is genuinely live at this URL, not guessed.
export const BASE_STYLES: BaseStyleOption[] = [
  {
    id: "bright",
    label: "Bright",
    style: "https://tiles.openfreemap.org/styles/bright",
    supportsTerrain: true,
  },
  {
    id: "positron",
    label: "Positron",
    style: "https://tiles.openfreemap.org/styles/positron",
    supportsTerrain: true,
  },
  {
    id: "liberty",
    label: "Liberty",
    style: "https://tiles.openfreemap.org/styles/liberty",
    supportsTerrain: true,
  },
  {
    id: "dark",
    label: "Dark",
    style: "https://tiles.openfreemap.org/styles/dark",
    supportsTerrain: true,
  },
  {
    id: "satellite",
    label: "Satellite",
    style: SATELLITE_STYLE,
    supportsTerrain: false,
  },
];

export const DEFAULT_BASE_STYLE_ID: BaseStyleId = "satellite";

export function findBaseStyle(id: BaseStyleId): BaseStyleOption {
  return BASE_STYLES.find((s) => s.id === id) ?? BASE_STYLES[0];
}

// AWS's public elevation-tiles-prod S3 bucket — free, no API key, Terrarium-
// encoded DEM tiles, the de facto free standard for MapLibre's raster-dem
// source type ("terrarium" is a built-in MapLibre decode). Verified live.
export const HILLSHADE_SOURCE_ID = "terrain-hillshade";

export const HILLSHADE_SOURCE: RasterDEMSourceSpecification = {
  type: "raster-dem",
  tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
  tileSize: 256,
  encoding: "terrarium",
  maxzoom: 15,
};

// Low exaggeration + muted shadow/highlight colors (not the stark black/
// white defaults) so this reads as subtle relief texture, not a dominant
// visual element competing with the aircraft markers. hillshade has no
// opacity paint property — subtlety has to come from these instead.
export const HILLSHADE_LAYER: LayerSpecification = {
  id: HILLSHADE_SOURCE_ID,
  type: "hillshade",
  source: HILLSHADE_SOURCE_ID,
  paint: {
    "hillshade-exaggeration": 0.25,
    "hillshade-shadow-color": "#5b5b5b",
    "hillshade-highlight-color": "#f5f5f0",
    "hillshade-accent-color": "#5b5b5b",
  },
};
