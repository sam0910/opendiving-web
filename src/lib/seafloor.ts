// Finding the best seafloor depth data for a point: the sources there are, what each
// answers, and the rule for choosing between them. The network half lives in
// `seafloor.server.ts`; everything here is pure, so it can be tested without it.
//
// The sources and the rule follow Submersion's site seascape (GPL-3.0, re-implemented
// here rather than copied): every source that covers the point is asked how fine its
// data is, they are tried finest-first, and the first grid that is mostly readings and
// at least partly water wins.

import type { SeascapeGrid } from "@/lib/seascape-grid";
import { METRES_PER_DEG_LAT, METRES_PER_DEG_LON } from "@/lib/seascape-grid";

export type SeafloorSourceId =
  "noaa_dem" | "emodnet" | "khoa" | "gmrt" | "etopo2022";

export interface SeafloorSourceInfo {
  id: SeafloorSourceId;
  label: string;
  /** Credit the source asks for, shown wherever its data is drawn. */
  credit: string;
  url: string;
}

export const SEAFLOOR_SOURCES: Record<SeafloorSourceId, SeafloorSourceInfo> = {
  noaa_dem: {
    id: "noaa_dem",
    label: "NOAA DEM",
    credit:
      "NOAA National Centers for Environmental Information, coastal Digital Elevation Models. US public domain.",
    url: "https://www.ncei.noaa.gov/products/coastal-elevation-models",
  },
  emodnet: {
    id: "emodnet",
    label: "EMODnet",
    credit:
      "EMODnet Bathymetry Consortium (2024): EMODnet Digital Bathymetry (DTM 2024). CC BY 4.0.",
    url: "https://emodnet.ec.europa.eu/en/bathymetry",
  },
  khoa: {
    id: "khoa",
    label: "KHOA",
    credit:
      "Korea Hydrographic and Oceanographic Agency (KHOA), water depth for natural science and ocean models (BADA 2024), via the Public Data Portal (data.go.kr).",
    url: "https://www.data.go.kr",
  },
  gmrt: {
    id: "gmrt",
    label: "GMRT",
    credit:
      "GMRT (Global Multi-Resolution Topography) synthesis, Lamont-Doherty Earth Observatory, Columbia University. CC BY 4.0.",
    url: "https://www.gmrt.org",
  },
  etopo2022: {
    id: "etopo2022",
    label: "ETOPO 2022",
    credit:
      "NOAA NCEI (2022): ETOPO 2022 15 Arc-Second Global Relief Model. US public domain.",
    url: "https://www.ncei.noaa.gov/products/etopo-global-relief-model",
  },
};

/**
 * The areas a view may cover, in metres a side, widest first. 2 km is plenty for a dive
 * site, and keeps every source's request small: one page of KHOA's API, for one.
 */
export const SEAFLOOR_SPANS = [2000, 1000];
export const SEAFLOOR_MAX_SPAN_METERS = SEAFLOOR_SPANS[0];

/** What happened when a source was considered for a point. */
export interface SeafloorAttempt {
  source: SeafloorSourceId;
  outcome:
    | "used"
    | "no coverage"
    | "not configured"
    | "not needed"
    | "too coarse"
    | "too little data"
    | "mostly land"
    | "failed";
  /** The source's own cell size there, in metres, when it said. */
  cellSizeMeters?: number;
  detail?: string;
}

export type SeafloorResult =
  | {
      status: "ok";
      source: SeafloorSourceId;
      grid: SeascapeGrid;
      attempts: SeafloorAttempt[];
    }
  /** Every source that answered says the point is on land. */
  | { status: "dry"; attempts: SeafloorAttempt[] }
  /** No source could be reached, or none gave a usable grid. */
  | { status: "failed"; attempts: SeafloorAttempt[] };

// A source moves ahead of one listed before it only when its data is more than twice
// as fine: close calls keep the listed order, which ranks surveyed regional data over
// global syntheses.
const PREEMPTION_FACTOR = 2;

/**
 * Sorts sources, given in preferred order, so a much finer one is tried first. A source
 * marked `holdsPlace` is never passed: national survey data outranks a global synthesis
 * whatever cell size the synthesis claims.
 */
export function orderByCellSize<
  T extends { cellSizeMeters: number; holdsPlace?: boolean },
>(candidates: T[]): T[] {
  const ordered = [...candidates];
  for (let i = 1; i < ordered.length; i++) {
    for (
      let j = i;
      j > 0 &&
      !ordered[j - 1].holdsPlace &&
      ordered[j - 1].cellSizeMeters >
        PREEMPTION_FACTOR * ordered[j].cellSizeMeters;
      j--
    ) {
      [ordered[j - 1], ordered[j]] = [ordered[j], ordered[j - 1]];
    }
  }
  return ordered;
}

/** Roughly how far apart neighbouring cells are, on the coarser of the two axes. */
export function cellSizeMeters(
  cellLat: number,
  cellLon: number,
  lat: number,
): number {
  return Math.max(
    cellLat * METRES_PER_DEG_LAT,
    cellLon * METRES_PER_DEG_LON * Math.cos((lat * Math.PI) / 180),
  );
}

/**
 * Reads an ERDDAP griddap `.json` answer (`{table: {columnNames, rows}}`, one row per
 * cell as `[latitude, longitude, value]`) into a depth grid. ERDDAP serves elevation,
 * so the value is negated; a null stays empty.
 */
export function parseErddapGrid(
  body: unknown,
  centerLat: number,
  centerLon: number,
): SeascapeGrid {
  const rows = (body as { table?: { rows?: unknown } })?.table?.rows;
  if (!Array.isArray(rows)) throw new Error("ERDDAP answer has no table rows");

  const lats = [...new Set(rows.map((row) => Number(row[0])))].sort(
    (a, b) => a - b,
  );
  const lons = [...new Set(rows.map((row) => Number(row[1])))].sort(
    (a, b) => a - b,
  );
  if (lats.length < 2 || lons.length < 2) {
    throw new Error("ERDDAP answer has fewer than two rows or columns");
  }
  const latIndex = new Map(lats.map((lat, i) => [lat, i]));
  const lonIndex = new Map(lons.map((lon, i) => [lon, i]));

  const depths: (number | null)[] = new Array(lats.length * lons.length).fill(
    null,
  );
  for (const row of rows) {
    const value = row[2];
    const r = latIndex.get(Number(row[0]));
    const c = lonIndex.get(Number(row[1]));
    if (r === undefined || c === undefined) continue;
    depths[r * lons.length + c] =
      typeof value === "number" && Number.isFinite(value) ? -value : null;
  }

  const cellLat = lats[1] - lats[0];
  const cellLon = lons[1] - lons[0];
  return {
    originLat: lats[0],
    originLon: lons[0],
    cellLat,
    cellLon,
    rows: lats.length,
    cols: lons.length,
    depths,
    resolutionMeters: cellSizeMeters(cellLat, cellLon, centerLat),
    centerLat,
    centerLon,
  };
}

/**
 * Reads the one TIFF shape an ArcGIS ImageServer `exportImage` answers with when asked
 * for `format=tiff&pixelType=F32`: little-endian, uncompressed, one band of 32-bit
 * floats, in tiles or strips. The image covers `bounds` exactly, rows north first.
 * Values are elevations; NaN and the huge negative fill some servers use are empty.
 */
export function parseFloat32Tiff(
  buffer: ArrayBuffer,
  bounds: { north: number; south: number; east: number; west: number },
  centerLat: number,
  centerLon: number,
): SeascapeGrid {
  const view = new DataView(buffer);
  if (view.getUint16(0) !== 0x4949 || view.getUint16(2, true) !== 42) {
    throw new Error("Not a little-endian TIFF");
  }

  const tags = new Map<number, number[]>();
  const ifd = view.getUint32(4, true);
  const count = view.getUint16(ifd, true);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    const tag = view.getUint16(entry, true);
    const type = view.getUint16(entry + 2, true);
    const n = view.getUint32(entry + 4, true);
    // SHORT (3) and LONG (4) are the only types the layout tags use.
    const size = type === 3 ? 2 : type === 4 ? 4 : 0;
    if (size === 0) continue;
    const at = n * size <= 4 ? entry + 8 : view.getUint32(entry + 8, true);
    const values: number[] = [];
    for (let k = 0; k < n; k++) {
      values.push(
        size === 2
          ? view.getUint16(at + k * 2, true)
          : view.getUint32(at + k * 4, true),
      );
    }
    tags.set(tag, values);
  }

  const one = (tag: number, fallback?: number) => {
    const value = tags.get(tag)?.[0] ?? fallback;
    if (value === undefined) throw new Error(`TIFF is missing tag ${tag}`);
    return value;
  };
  const width = one(256);
  const height = one(257);
  if (one(258) !== 32 || one(339, 1) !== 3) {
    throw new Error("TIFF is not 32-bit float");
  }
  if (one(259, 1) !== 1) throw new Error("TIFF is compressed");
  if (one(277, 1) !== 1) throw new Error("TIFF has more than one band");

  // Each block (a tile, or a strip as a tile the full width of the image) and where
  // its top-left pixel sits.
  const values = new Float32Array(width * height).fill(NaN);
  const tileWidth = tags.get(322)?.[0];
  const tileHeight = tags.get(323)?.[0];
  const blocks =
    tileWidth && tileHeight
      ? {
          offsets: tags.get(324) ?? [],
          w: tileWidth,
          h: tileHeight,
          across: Math.ceil(width / tileWidth),
        }
      : {
          offsets: tags.get(273) ?? [],
          w: width,
          h: one(278, height),
          across: 1,
        };
  blocks.offsets.forEach((offset, b) => {
    const x0 = (b % blocks.across) * blocks.w;
    const y0 = Math.floor(b / blocks.across) * blocks.h;
    for (let y = 0; y < blocks.h && y0 + y < height; y++) {
      for (let x = 0; x < blocks.w && x0 + x < width; x++) {
        values[(y0 + y) * width + x0 + x] = view.getFloat32(
          offset + (y * blocks.w + x) * 4,
          true,
        );
      }
    }
  });

  const depths: (number | null)[] = new Array(width * height);
  for (let row = 0; row < height; row++) {
    const fileRow = height - 1 - row;
    for (let col = 0; col < width; col++) {
      const value = values[fileRow * width + col];
      depths[row * width + col] =
        Number.isFinite(value) && value > -1e30 ? -value : null;
    }
  }

  const cellLat = (bounds.north - bounds.south) / height;
  const cellLon = (bounds.east - bounds.west) / width;
  return {
    originLat: bounds.south + cellLat / 2,
    originLon: bounds.west + cellLon / 2,
    cellLat,
    cellLon,
    rows: height,
    cols: width,
    depths,
    resolutionMeters: cellSizeMeters(cellLat, cellLon, centerLat),
    centerLat,
    centerLon,
  };
}

/** Thrown by a source that answered, but has no data for the area asked about. */
export class NoCoverageError extends Error {}

export interface DepthPoint {
  lat: number;
  lon: number;
  /** Metres, positive down. */
  depth: number;
}

/**
 * Reads one page of KHOA's water depth API (`GetWaterDepthApiService`, `type=json`).
 * Result code 03 means no data in the box, which is a decline rather than a failure;
 * any other code that is not 00 is an error, quota and key problems included.
 */
export function parseKhoaPage(body: unknown): {
  total: number;
  points: DepthPoint[];
} {
  const answer = body as {
    header?: { resultCode?: string; resultMsg?: string };
    body?: {
      totalCount?: number;
      items?: { item?: unknown } | "";
    };
  };
  const code = answer?.header?.resultCode;
  if (code === "03") throw new NoCoverageError("no KHOA data in this area");
  if (code !== "00") {
    throw new Error(
      `KHOA ${code ?? "?"} ${answer?.header?.resultMsg ?? "unexpected answer"}`,
    );
  }
  // A single result arrives as an object rather than a one-item list.
  const raw = answer.body?.items ? answer.body.items.item : undefined;
  const items = (Array.isArray(raw) ? raw : raw ? [raw] : []) as {
    lat?: unknown;
    lot?: unknown;
    dpwt?: unknown;
  }[];
  const points = items
    .map((item) => ({
      lat: Number(item.lat),
      lon: Number(item.lot),
      depth: Number(item.dpwt),
    }))
    .filter(
      (point) =>
        Number.isFinite(point.lat) &&
        Number.isFinite(point.lon) &&
        Number.isFinite(point.depth),
    );
  return { total: Number(answer.body?.totalCount ?? points.length), points };
}

/** Where land is: true for water, false for land, null where it isn't known. */
export type WaterTest = (lat: number, lon: number) => boolean | null;

/** How land is decided when gridding soundings that have none on land. */
export interface LandRule {
  /**
   * Depth given to a land cell: negative, so it stands above the water. A function
   * gives each land cell its own, from a source that measures land heights.
   */
  depth: number | ((lat: number, lon: number) => number);
  /**
   * Land where the nearest sounding is farther than this. Used wherever `isWater`
   * isn't given or doesn't know: see `gridPoints`.
   */
  beyondMeters: number;
  /** A coastline from map data, which wins over the gaps between soundings. */
  isWater?: WaterTest;
}

// Each cell asks the coastline at a 3 × 3 spread of spots across its own area, and is
// land if any of them is: an islet narrower than a cell still claims the cell it is in.
const COAST_SAMPLES = [-1 / 3, 0, 1 / 3];

/**
 * Lays scattered depth points onto a regular grid over `bounds`, `cellMeters` apart, by
 * inverse-distance weighting of the points within `radiusMeters` of each cell.
 *
 * With a `land` rule, a cell is land, and takes `land.depth`, when:
 *
 * - `land.isWater` says any part of the cell is land. Map data draws coastlines far
 *   finer than soundings are spaced, so this shows every islet the map shows. A water
 *   cell with no sounding inside the radius, in a gap a merged islet left, say, takes
 *   the nearest sounding's depth.
 * - Otherwise (no coastline, or none known there), its nearest point is farther than
 *   `land.beyondMeters`. For soundings laid on a regular lattice, set that a little past
 *   half the lattice's diagonal, the farthest any spot can be from a node: then even one
 *   missing node shows as land.
 *
 * Without a rule, only a cell with no point inside the radius is land, left empty.
 */
export function gridPoints(
  points: DepthPoint[],
  bounds: { north: number; south: number; east: number; west: number },
  cellMeters: number,
  radiusMeters: number,
  centerLat: number,
  centerLon: number,
  land?: LandRule,
): SeascapeGrid {
  const metresPerDegLon =
    METRES_PER_DEG_LON * Math.cos((centerLat * Math.PI) / 180);
  const cellLat = cellMeters / METRES_PER_DEG_LAT;
  const cellLon = cellMeters / metresPerDegLon;
  const rows = Math.max(
    2,
    Math.floor((bounds.north - bounds.south) / cellLat) + 1,
  );
  const cols = Math.max(
    2,
    Math.floor((bounds.east - bounds.west) / cellLon) + 1,
  );

  // Points in metres from the south-west corner, so distances are plain arithmetic.
  const local = points.map((point) => ({
    x: (point.lon - bounds.west) * metresPerDegLon,
    y: (point.lat - bounds.south) * METRES_PER_DEG_LAT,
    depth: point.depth,
  }));
  const radiusSquared = radiusMeters * radiusMeters;

  // What the coastline says about a cell: land if any spot in it is land, water if
  // it knows every spot, null if it knows none.
  const coast = (lat: number, lon: number): boolean | null => {
    if (!land?.isWater) return null;
    let known = false;
    for (const dy of COAST_SAMPLES) {
      for (const dx of COAST_SAMPLES) {
        const water = land.isWater(lat + dy * cellLat, lon + dx * cellLon);
        if (water === false) return false;
        if (water === true) known = true;
      }
    }
    return known ? true : null;
  };

  let usedCoast = false;
  const depths: (number | null)[] = new Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cellMeters;
      const y = r * cellMeters;
      let weights = 0;
      let sum = 0;
      let exact: number | null = null;
      let nearestSquared = Infinity;
      let nearestDepth: number | null = null;
      for (const point of local) {
        const dx = point.x - x;
        const dy = point.y - y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < nearestSquared) {
          nearestSquared = distanceSquared;
          nearestDepth = point.depth;
        }
        if (distanceSquared > radiusSquared) continue;
        if (distanceSquared < 1) {
          exact = point.depth;
          continue;
        }
        const weight = 1 / distanceSquared;
        weights += weight;
        sum += weight * point.depth;
      }
      const weighted = exact ?? (weights > 0 ? sum / weights : null);

      const cellLatitude = bounds.south + r * cellLat;
      const cellLongitude = bounds.west + c * cellLon;
      const landDepth = () =>
        typeof land!.depth === "function"
          ? land!.depth(cellLatitude, cellLongitude)
          : land!.depth;
      const water = coast(cellLatitude, cellLongitude);
      let depth: number | null;
      if (water === false) {
        depth = landDepth();
      } else if (water === true) {
        depth = weighted ?? nearestDepth;
      } else if (
        land &&
        nearestSquared > land.beyondMeters * land.beyondMeters
      ) {
        depth = landDepth();
      } else {
        depth = weighted;
      }
      if (water !== null) usedCoast = true;
      depths[r * cols + c] = depth;
    }
  }

  return {
    originLat: bounds.south,
    originLon: bounds.west,
    cellLat,
    cellLon,
    rows,
    cols,
    depths,
    resolutionMeters: cellMeters,
    centerLat,
    centerLon,
    ...(land ? { landFrom: usedCoast ? "openstreetmap" : "soundings" } : {}),
  };
}

/** A polygon from a vector tile, its rings in that tile's own pixel coordinates. */
export interface TilePolygon {
  rings: { x: number; y: number }[][];
}

/** The water polygons of one vector tile. */
export interface WaterTile {
  z: number;
  x: number;
  y: number;
  /** Pixels a side, 4096 for most tiles. */
  extent: number;
  polygons: TilePolygon[];
}

/** Where a point falls in the Web Mercator tile grid at zoom `z`, as fractional tiles. */
export function tilePosition(
  lat: number,
  lon: number,
  z: number,
): { x: number; y: number } {
  const n = 2 ** z;
  const phi = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n,
  };
}

/** The tiles at zoom `z` that a box touches. */
export function tilesCovering(
  bounds: { north: number; south: number; east: number; west: number },
  z: number,
): { x: number; y: number }[] {
  const northWest = tilePosition(bounds.north, bounds.west, z);
  const southEast = tilePosition(bounds.south, bounds.east, z);
  const tiles: { x: number; y: number }[] = [];
  for (let x = Math.floor(northWest.x); x <= Math.floor(southEast.x); x++) {
    for (let y = Math.floor(northWest.y); y <= Math.floor(southEast.y); y++) {
      tiles.push({ x, y });
    }
  }
  return tiles;
}

/** Whether a point is inside a polygon with holes, by the even-odd rule. */
function insidePolygon(polygon: TilePolygon, px: number, py: number): boolean {
  let inside = false;
  for (const ring of polygon.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (
        a.y > py !== b.y > py &&
        px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x
      ) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * A water test from vector-tile water polygons: water inside any polygon of the tile
 * the point falls in, land outside them all, and null off every tile given.
 */
export function waterTest(tiles: WaterTile[]): WaterTest {
  const byKey = new Map(tiles.map((tile) => [`${tile.x}/${tile.y}`, tile]));
  return (lat, lon) => {
    const z = tiles[0]?.z;
    if (z === undefined) return null;
    const position = tilePosition(lat, lon, z);
    const tile = byKey.get(
      `${Math.floor(position.x)}/${Math.floor(position.y)}`,
    );
    if (!tile) return null;
    const px = (position.x - tile.x) * tile.extent;
    const py = (position.y - tile.y) * tile.extent;
    return tile.polygons.some((polygon) => insidePolygon(polygon, px, py));
  };
}

/** A Terrarium-encoded elevation pixel (AWS Terrain Tiles) in metres above sea level. */
export function terrariumElevation(
  red: number,
  green: number,
  blue: number,
): number {
  return red * 256 + green + blue / 256 - 32768;
}

/** One decoded terrain tile: elevations in metres, row by row from its north-west. */
export interface TerrainTile {
  x: number;
  y: number;
  /** Pixels a side. */
  size: number;
  elevations: Float32Array;
}

/**
 * Elevation at a point by bilinear interpolation between pixel centres, across tile
 * edges, or null where a needed pixel is on no tile given.
 */
export function terrainSampler(
  tiles: TerrainTile[],
  z: number,
): (lat: number, lon: number) => number | null {
  const byKey = new Map(tiles.map((tile) => [`${tile.x}/${tile.y}`, tile]));
  const size = tiles[0]?.size ?? 256;
  const pixel = (gx: number, gy: number): number | null => {
    const tile = byKey.get(`${Math.floor(gx / size)}/${Math.floor(gy / size)}`);
    if (!tile) return null;
    const px = gx - tile.x * size;
    const py = gy - tile.y * size;
    return tile.elevations[py * size + px];
  };
  return (lat, lon) => {
    const position = tilePosition(lat, lon, z);
    // Global pixel coordinates, shifted so whole numbers fall on pixel centres.
    const fx = position.x * size - 0.5;
    const fy = position.y * size - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const corners = [
      pixel(x0, y0),
      pixel(x0 + 1, y0),
      pixel(x0, y0 + 1),
      pixel(x0 + 1, y0 + 1),
    ];
    if (corners.some((value) => value === null)) return null;
    const [nw, ne, sw, se] = corners as number[];
    const tx = fx - x0;
    const ty = fy - y0;
    return (
      (nw * (1 - tx) + ne * tx) * (1 - ty) + (sw * (1 - tx) + se * tx) * ty
    );
  };
}
