// A seafloor depth grid around one point, as the seascape sample draws it.
//
// Depth is in metres, **positive down**; a negative depth is land above the waterline,
// kept rather than dropped so a coast or an island still has a shape, and `null` is a
// cell with no reading. `GET /seafloor` answers in exactly that convention, so reading
// its grid is a renaming and nothing more.

import type { SeafloorGrid } from "@/lib/api/seafloor";

/** Metres per degree of latitude, and of longitude at the equator. */
export const METRES_PER_DEG_LAT = 110540;
export const METRES_PER_DEG_LON = 111320;

export interface SeascapeGrid {
  /** Centre of the south-west cell. */
  originLat: number;
  originLon: number;
  cellLat: number;
  cellLon: number;
  rows: number;
  cols: number;
  /** Row-major, row 0 the southernmost. */
  depths: (number | null)[];
  /** Roughly how far apart two neighbouring cells are, east-west. */
  resolutionMeters: number;
  /** The point the grid was fetched around. */
  centerLat: number;
  centerLon: number;
}

/** The grid from an API answer, in the shape the scene draws. */
export function toSeascapeGrid(grid: SeafloorGrid): SeascapeGrid {
  return {
    originLat: grid.origin_lat,
    originLon: grid.origin_lon,
    cellLat: grid.cell_lat,
    cellLon: grid.cell_lon,
    rows: grid.rows,
    cols: grid.cols,
    depths: grid.depths,
    resolutionMeters: grid.resolution_meters,
    centerLat: grid.center_lat,
    centerLon: grid.center_lon,
  };
}
