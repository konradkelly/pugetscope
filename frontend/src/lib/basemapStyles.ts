import type { LayerSpecification, RasterDEMSourceSpecification, StyleSpecification } from "maplibre-gl";

export type BaseStyleId = "bright" | "positron" | "liberty" | "dark" | "topographic";

export interface BaseStyleOption {
  id: BaseStyleId;
  label: string;
  style: string | StyleSpecification;
  // False only for "topographic" — OpenTopoMap already bakes in its own
  // relief shading, so layering the hillshade overlay on top would just be
  // redundant (see HILLSHADE_SOURCE_ID below).
  supportsTerrain: boolean;
}

// OpenTopoMap raster XYZ tiles — free, no API key, CORS open (verified live).
// Community-run tile server with a fair-use policy discouraging heavy/
// production traffic; accepted as reasonable for a low-traffic portfolio
// project (see docs/SPEC.md §18). Not a style-JSON URL like the OpenFreeMap
// styles below, so this is a minimal inline style object instead: one
// raster source/layer, no sprite/glyphs needed. The attribution string is
// picked up automatically by MapLibre's default AttributionControl (the app
// never sets attributionControl: false), which satisfies OpenTopoMap's
// attribution requirement with no extra UI work.
const TOPOGRAPHIC_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    opentopomap: {
      type: "raster",
      tiles: [
        "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
        "https://b.tile.opentopomap.org/{z}/{x}/{y}.png",
        "https://c.tile.opentopomap.org/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      maxzoom: 17,
      attribution:
        'map data © <a href="https://openstreetmap.org">OpenStreetMap</a> contributors, SRTM | map style © <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
    },
  },
  layers: [{ id: "opentopomap", type: "raster", source: "opentopomap" }],
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
    id: "topographic",
    label: "Topographic",
    style: TOPOGRAPHIC_STYLE,
    supportsTerrain: false,
  },
];

export const DEFAULT_BASE_STYLE_ID: BaseStyleId = "bright";

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
