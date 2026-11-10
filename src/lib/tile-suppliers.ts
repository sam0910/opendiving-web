// Who draws the seascape explorer's 2D map. The app's own basemap (OpenStreetMap via
// OpenFreeMap) needs nothing; Google and Mapbox need a key each, and bill per tile
// beyond their free allowance. Which ones are offered, and which comes first, is the
// operator's choice (`SEASCAPE_MAP_SUPPLIERS`); a viewer then switches between them.

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
 * The supplier ids a `SEASCAPE_MAP_SUPPLIERS` value names, in its order, without
 * repeats. Unknown ids are dropped; unset or empty gives every supplier, the app's own
 * basemap first.
 */
export function parseSupplierList(value: string | undefined): TileSupplierId[] {
  const ids = (value ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter((id): id is TileSupplierId =>
      (TILE_SUPPLIER_IDS as readonly string[]).includes(id),
    );
  return ids.length > 0 ? [...new Set(ids)] : [...TILE_SUPPLIER_IDS];
}
