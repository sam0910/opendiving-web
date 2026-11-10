import { googleTiles } from "@/lib/google-tiles.server";
import {
  parseSupplier,
  type TileSupplier,
  type TileSupplierId,
} from "@/lib/tile-suppliers";

export const MAPBOX_TILES_ORIGIN = "https://api.mapbox.com";

// Mapbox styles drawn as raster tiles (its Static Tiles API): 256 px tiles at 2x, so
// MapLibre's raster layer needs nothing special.
const MAPBOX_STYLES: Record<string, string> = {
  "mapbox-satellite": "satellite-v9",
  "mapbox-streets": "streets-v12",
};
const MAPBOX_CREDIT =
  "[© Mapbox](https://www.mapbox.com/about/maps/) [© OpenStreetMap](https://www.openstreetmap.org/copyright) [Improve this map](https://www.mapbox.com/map-feedback/)";

const LABELS: Record<TileSupplierId, string> = {
  openfreemap: "OpenStreetMap",
  "google-satellite": "Google satellite",
  "google-roadmap": "Google",
  "mapbox-satellite": "Mapbox satellite",
  "mapbox-streets": "Mapbox",
};

async function resolve(id: TileSupplierId): Promise<TileSupplier | null> {
  const base = { id, label: LABELS[id] };
  if (id === "openfreemap") {
    return { ...base, template: null, credit: null, mark: null, dark: false };
  }

  if (id === "google-satellite" || id === "google-roadmap") {
    const tiles = await googleTiles(
      id === "google-satellite" ? "satellite" : "roadmap",
    );
    if (!tiles) return null;
    return {
      ...base,
      template: tiles.template,
      credit: null,
      mark: "Google Maps",
      google: { session: tiles.session, key: tiles.key },
      dark: id === "google-satellite",
    };
  }

  const token = process.env.MAPBOX_ACCESS_TOKEN?.trim();
  if (!token) return null;
  const satellite = id === "mapbox-satellite";
  return {
    ...base,
    template: `${MAPBOX_TILES_ORIGIN}/styles/v1/mapbox/${MAPBOX_STYLES[id]}/tiles/256/{z}/{x}/{y}@2x?access_token=${encodeURIComponent(token)}`,
    credit: satellite ? `${MAPBOX_CREDIT} © Maxar` : MAPBOX_CREDIT,
    mark: "mapbox",
    dark: satellite,
  };
}

/**
 * The supplier named in `SEASCAPE_MAP_SUPPLIERS` that draws the explorer's map. No
 * fallback: one missing its key fails here rather than the map quietly drawing another.
 */
export async function tileSupplier(): Promise<TileSupplier> {
  const id = parseSupplier(process.env.SEASCAPE_MAP_SUPPLIERS);
  const supplier = await resolve(id);
  if (!supplier) {
    throw new Error(`Seascape map: ${id} needs its key in .env.local`);
  }
  return supplier;
}
