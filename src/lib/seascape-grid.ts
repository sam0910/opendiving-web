// A seafloor depth grid around one point, as the seascape sample draws it.
//
// Depth is in metres, **positive down**: the sources publish elevation, negative under
// water, and the sign is flipped once, here, at the boundary. A negative depth is land
// above the waterline, kept rather than dropped so a coast or an island still has a
// shape; `null` is a cell the source had no reading for.

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
  /**
   * Where the coastline came from, for a source with no land of its own: map data, or
   * the gaps between its soundings. Absent for a source that measures land itself.
   */
  landFrom?: "openstreetmap" | "soundings";
  /**
   * Where land heights came from, for such a source: AWS Terrain Tiles, GMRT when
   * those can't be had, or a flat placeholder when neither can.
   */
  landHeightFrom?: "aws-terrain" | "gmrt" | "flat";
}

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** A square `spanMeters` on a side, centred on the point. */
export function boundsAround(
  lat: number,
  lon: number,
  spanMeters: number,
): Bounds {
  const dLat = spanMeters / 2 / METRES_PER_DEG_LAT;
  const dLon =
    spanMeters /
    2 /
    (METRES_PER_DEG_LON * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return {
    north: lat + dLat,
    south: lat - dLat,
    east: lon + dLon,
    west: lon - dLon,
  };
}

/**
 * Reads an ESRI ASCII grid (what GMRT's `format=esriascii` answers) into a depth grid.
 *
 * The file lists rows north first; the grid stores them south first, so row 0 is the
 * southern edge. The corner in the header is the cell's outer corner, and the origin
 * is moved half a cell in to the cell's centre.
 */
export function parseEsriAscii(
  text: string,
  centerLat: number,
  centerLon: number,
): SeascapeGrid {
  const lines = text.split(/\r?\n/);
  const header = new Map<string, number>();
  let line = 0;
  for (; line < lines.length; line++) {
    const match = /^\s*([a-z_]+)\s+(\S+)\s*$/i.exec(lines[line]);
    if (!match) break;
    header.set(match[1].toLowerCase(), Number(match[2]));
  }

  const read = (key: string): number => {
    const value = header.get(key);
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`ESRI ASCII grid is missing "${key}"`);
    }
    return value;
  };
  const cols = read("ncols");
  const rows = read("nrows");
  const xll = read("xllcorner");
  const yll = read("yllcorner");
  const cellSize = read("cellsize");
  const nodata = header.get("nodata_value");

  const values = lines
    .slice(line)
    .join(" ")
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "")
    .map(Number);
  if (values.length < rows * cols) {
    throw new Error(
      `ESRI ASCII grid has ${values.length} values, expected ${rows * cols}`,
    );
  }

  const depths: (number | null)[] = new Array(rows * cols);
  for (let fileRow = 0; fileRow < rows; fileRow++) {
    const row = rows - 1 - fileRow;
    for (let col = 0; col < cols; col++) {
      const elevation = values[fileRow * cols + col];
      depths[row * cols + col] =
        elevation === nodata || !Number.isFinite(elevation) ? null : -elevation;
    }
  }

  const originLat = yll + cellSize / 2;
  return {
    originLat,
    originLon: xll + cellSize / 2,
    cellLat: cellSize,
    cellLon: cellSize,
    rows,
    cols,
    depths,
    resolutionMeters:
      cellSize * METRES_PER_DEG_LON * Math.cos((centerLat * Math.PI) / 180),
    centerLat,
    centerLon,
  };
}

/**
 * Shrinks the grid to at most `maxDim` cells a side by averaging blocks of cells.
 *
 * A block's readings are averaged and its empty cells ignored; a block with no reading
 * at all stays empty. The origin moves to the centre of the first block.
 */
export function downsample(grid: SeascapeGrid, maxDim: number): SeascapeGrid {
  const rowStep = Math.ceil(grid.rows / maxDim);
  const colStep = Math.ceil(grid.cols / maxDim);
  if (rowStep <= 1 && colStep <= 1) return grid;

  const rows = Math.ceil(grid.rows / rowStep);
  const cols = Math.ceil(grid.cols / colStep);
  const depths: (number | null)[] = new Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      let count = 0;
      for (
        let rr = r * rowStep;
        rr < Math.min((r + 1) * rowStep, grid.rows);
        rr++
      ) {
        for (
          let cc = c * colStep;
          cc < Math.min((c + 1) * colStep, grid.cols);
          cc++
        ) {
          const depth = grid.depths[rr * grid.cols + cc];
          if (depth !== null) {
            sum += depth;
            count++;
          }
        }
      }
      depths[r * cols + c] = count === 0 ? null : sum / count;
    }
  }

  return {
    ...grid,
    originLat: grid.originLat + (grid.cellLat * (rowStep - 1)) / 2,
    originLon: grid.originLon + (grid.cellLon * (colStep - 1)) / 2,
    cellLat: grid.cellLat * rowStep,
    cellLon: grid.cellLon * colStep,
    rows,
    cols,
    depths,
    resolutionMeters: grid.resolutionMeters * Math.max(rowStep, colStep),
  };
}

/**
 * Trims a grid that came back wider than asked for (a coarse source fetched over a
 * wider box) to the cells whose centres fall inside `bounds`. A grid within 10% of
 * the bounds is returned as it is.
 */
export function cropToBounds(grid: SeascapeGrid, bounds: Bounds): SeascapeGrid {
  const latSpan = (grid.rows - 1) * grid.cellLat;
  const lonSpan = (grid.cols - 1) * grid.cellLon;
  if (
    latSpan <= (bounds.north - bounds.south) * 1.1 &&
    lonSpan <= (bounds.east - bounds.west) * 1.1
  ) {
    return grid;
  }

  const inside = (
    start: number,
    cell: number,
    count: number,
    lo: number,
    hi: number,
  ) => {
    const first = Math.max(0, Math.ceil((lo - start) / cell));
    const last = Math.min(count - 1, Math.floor((hi - start) / cell));
    return { first, size: Math.max(0, last - first + 1) };
  };
  const rows = inside(
    grid.originLat,
    grid.cellLat,
    grid.rows,
    bounds.south,
    bounds.north,
  );
  const cols = inside(
    grid.originLon,
    grid.cellLon,
    grid.cols,
    bounds.west,
    bounds.east,
  );
  const depths: (number | null)[] = [];
  for (let r = rows.first; r < rows.first + rows.size; r++) {
    for (let c = cols.first; c < cols.first + cols.size; c++) {
      depths.push(grid.depths[r * grid.cols + c]);
    }
  }
  return {
    ...grid,
    originLat: grid.originLat + rows.first * grid.cellLat,
    originLon: grid.originLon + cols.first * grid.cellLon,
    rows: rows.size,
    cols: cols.size,
    depths,
  };
}

/** The share of cells with any reading at all. */
export function knownFraction(grid: SeascapeGrid): number {
  if (grid.depths.length === 0) return 0;
  return (
    grid.depths.filter((depth) => depth !== null).length / grid.depths.length
  );
}

/** The share of cells with a reading that are under water. */
export function wetFraction(grid: SeascapeGrid): number {
  const known = grid.depths.filter((depth) => depth !== null) as number[];
  if (known.length === 0) return 0;
  return known.filter((depth) => depth > 0).length / known.length;
}
