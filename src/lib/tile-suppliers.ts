// Who draws the seascape explorer's 2D map. The app's own basemap (OpenStreetMap via
// OpenFreeMap) needs nothing; Google and Mapbox need a key each, and bill per tile
// beyond their free allowance. Which one draws the map is the operator's choice
// (`SEASCAPE_MAP_SUPPLIERS`); viewers don't choose.

export const TILE_SUPPLIER_IDS = [
  "openfreemap",
  "google-satellite",
  "google-roadmap",
  "mapbox-satellite",
  "mapbox-streets",
] as const;

export type TileSupplierId = (typeof TILE_SUPPLIER_IDS)[number];

export interface TileSupplier {
  id: TileSupplierId;
  label: string;
  /** A `{z}/{x}/{y}` raster template, or null for the app's own configured basemap. */
  template: string | null;
  /**
   * The credit line, `[label](href)` links allowed, or null for the basemap's own.
   * Google's is not fixed: it is asked of its viewport endpoint as the map moves.
   */
  credit: string | null;
  /** The provider's mark, which its terms want on the map. */
  mark: "Google Maps" | "mapbox" | null;
  /** What Google's viewport-attribution requests need. */
  google?: { session: string; key: string };
  /** Imagery: dark under the mark, which then wants light text. */
  dark: boolean;
}

/**
 * The supplier a `SEASCAPE_MAP_SUPPLIERS` value names, the app's own basemap when unset
 * or empty. Anything else, a list included, is a mistake to fix rather than guess at.
 */
export function parseSupplier(value: string | undefined): TileSupplierId {
  const id = (value ?? "").trim().toLowerCase();
  if (!id) return "openfreemap";
  if ((TILE_SUPPLIER_IDS as readonly string[]).includes(id)) {
    return id as TileSupplierId;
  }
  throw new Error(
    `SEASCAPE_MAP_SUPPLIERS: "${value}" is not one of ${TILE_SUPPLIER_IDS.join(", ")}`,
  );
}
