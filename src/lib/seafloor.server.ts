import { VectorTile } from "@mapbox/vector-tile";
import { cacheLife } from "next/cache";
import { PbfReader } from "pbf";
import sharp from "sharp";

import {
  boundsAround,
  cropToBounds,
  downsample,
  knownFraction,
  parseEsriAscii,
  wetFraction,
  type Bounds,
  type SeascapeGrid,
} from "@/lib/seascape-grid";
import { depthAt } from "@/lib/seascape-scene";
import {
  cellSizeMeters,
  gridPoints,
  NoCoverageError,
  orderByCellSize,
  parseErddapGrid,
  parseFloat32Tiff,
  parseKhoaPage,
  SEAFLOOR_MAX_SPAN_METERS,
  terrainSampler,
  terrariumElevation,
  tilesCovering,
  waterTest,
  type DepthPoint,
  type TerrainTile,
  type TilePolygon,
  type WaterTest,
  type WaterTile,
  type SeafloorAttempt,
  type SeafloorResult,
  type SeafloorSourceId,
} from "@/lib/seafloor";

// Every source is fetched by the server: the CSP's `connect-src` names no third party
// but the basemap, two of them send no CORS headers, and KHOA's needs a key that must
// never reach a browser. All are keyless except KHOA (`KHOA_API_KEY`).

// A grid is used only when at least this share of its cells are readings, and at least
// this share of those are water. Below the first a source has patchy coverage there;
// below the second the point is inland, and a source that knows the land is worth
// nothing to a seascape.
const MIN_KNOWN_FRACTION = 0.6;
const MIN_WET_FRACTION = 0.1;
// Fewer cells than this on a side is no surface to draw: ETOPO at a 1 km span.
const MIN_CELLS = 6;
// The most cells a side the view gets. Finer data is averaged down to it.
const MAX_GRID_DIM = 160;
// Pixels a side asked of NOAA's `exportImage`, which resamples to whatever it is
// asked: exactly what the view draws, so nothing is averaged away twice.
const NOAA_REQUEST_DIM = MAX_GRID_DIM;

interface Source {
  id: SeafloorSourceId;
  /** Whether a dry grid from it proves the point is on land. */
  global: boolean;
  /**
   * The share of cells that must have a reading. A source whose gaps are simply land
   * (it only lists soundings) sets 0, so a coastal view is not refused for its coast.
   */
  minKnownFraction?: number;
  /** Never passed by a finer-claiming source: see `orderByCellSize`. */
  holdsPlace?: boolean;
  /**
   * How fine its data is at the point, in metres, or null when it has none there.
   * Throws when it could not tell, which is a failure rather than a decline.
   */
  probe: (lat: number, lon: number) => Promise<number | null>;
  fetch: (lat: number, lon: number, bounds: Bounds) => Promise<SeascapeGrid>;
}

/** A source that needs configuration it has not been given. */
class NotConfiguredError extends Error {}

async function get(url: URL, timeoutMs: number): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

// --- NOAA NCEI coastal DEMs --------------------------------------------------------
// Coastal elevation models down to a few metres, merged into one ArcGIS image service.
// Only around the US and a handful of islands; elsewhere the service holds nothing
// but the ETOPO background, which the ETOPO source serves directly.

const NOAA_DEM =
  "https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_all/ImageServer";
// Coarser than this, the mosaic is only offering its ETOPO background.
const NOAA_USEFUL_CELL_METERS = 50;
// Where the mosaic holds a DEM finer than 50 m, padded about a degree, as
// [minLat, maxLat, minLon, maxLon]. Outside these it is not worth asking.
const NOAA_COVERAGE: [number, number, number, number][] = [
  [23, 50, -128, -63], // US mainland, Bermuda, Bahamas
  [50, 72, -180, -129], // Alaska, through the central Aleutians
  [50, 56, 171, 180], // western Aleutians
  [17, 30, -180, -153], // Hawaii
  [16.5, 19.5, -68.5, -63.5], // Puerto Rico, Virgin Islands
  [11, 14, -63, -60.5], // Grenada
  [12, 21, 143.5, 147], // Guam, Northern Mariana Islands
  [18.5, 20, 166, 167.5], // Wake Island
  [-15.5, -10.5, -172, -168], // American Samoa
  [-23, -15.5, -161, -148], // Cook and Society Islands
  [-3, 3, -93, -86.5], // Galapagos
];

const noaaDem: Source = {
  id: "noaa_dem",
  global: false,
  async probe(lat, lon) {
    const covered = NOAA_COVERAGE.some(
      ([minLat, maxLat, minLon, maxLon]) =>
        lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon,
    );
    if (!covered) return null;

    const url = new URL(`${NOAA_DEM}/identify`);
    url.searchParams.set("geometry", JSON.stringify({ x: lon, y: lat }));
    url.searchParams.set("geometryType", "esriGeometryPoint");
    url.searchParams.set("returnCatalogItems", "true");
    // The default of three hides a site's DEM behind the ETOPO background layers.
    url.searchParams.set("maxItemCount", "25");
    url.searchParams.set("f", "json");
    const body = (await (await get(url, 15_000)).json()) as {
      catalogItems?: { features?: { attributes?: { LowPS?: unknown } }[] };
    };
    // LowPS is the item's finest pixel, in degrees.
    const finest = Math.min(
      ...(body.catalogItems?.features ?? [])
        .map((item) => Number(item.attributes?.LowPS))
        .filter((degrees) => degrees > 0),
    );
    if (!Number.isFinite(finest)) return null;
    const meters = cellSizeMeters(finest, finest, lat);
    return meters <= NOAA_USEFUL_CELL_METERS ? meters : null;
  },
  async fetch(lat, lon, bounds) {
    const url = new URL(`${NOAA_DEM}/exportImage`);
    url.searchParams.set(
      "bbox",
      `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`,
    );
    url.searchParams.set("bboxSR", "4326");
    url.searchParams.set("imageSR", "4326");
    url.searchParams.set("size", `${NOAA_REQUEST_DIM},${NOAA_REQUEST_DIM}`);
    url.searchParams.set("format", "tiff");
    url.searchParams.set("pixelType", "F32");
    url.searchParams.set("noDataInterpretation", "esriNoDataMatchAny");
    url.searchParams.set("interpolation", "RSP_BilinearInterpolation");
    url.searchParams.set("f", "image");
    const buffer = await (await get(url, 15_000)).arrayBuffer();
    return parseFloat32Tiff(buffer, bounds, lat, lon);
  },
};

// --- EMODnet Bathymetry ------------------------------------------------------------
// The European seas' surveyed digital terrain model, about 115 m, plus one Caribbean
// tile. Its vertical datum is lowest astronomical tide rather than mean sea level.

const EMODNET_ERDDAP = "https://erddap.emodnet.eu/erddap/griddap";
const EMODNET_TILES = [
  {
    minLat: 11,
    maxLat: 19,
    minLon: -70.5,
    maxLon: -59.5,
    dataset: "bathymetry_dtm_carib_2024",
  },
  {
    minLat: 15,
    maxLat: 90,
    minLon: -36,
    maxLon: 43,
    dataset: "bathymetry_dtm_2024",
  },
];
const emodnetTile = (lat: number, lon: number) =>
  EMODNET_TILES.find(
    (tile) =>
      lat >= tile.minLat &&
      lat <= tile.maxLat &&
      lon >= tile.minLon &&
      lon <= tile.maxLon,
  );

function erddapUrl(
  base: string,
  dataset: string,
  variable: string,
  bounds: Bounds,
): URL {
  // ERDDAP's subset syntax goes in the query string as it is, brackets included.
  return new URL(
    `${base}/${dataset}.json?${variable}` +
      encodeURI(
        `[(${bounds.south}):(${bounds.north})][(${bounds.west}):(${bounds.east})]`,
      ),
  );
}

const emodnet: Source = {
  id: "emodnet",
  global: false,
  async probe(lat, lon) {
    return emodnetTile(lat, lon) ? 115 : null;
  },
  async fetch(lat, lon, bounds) {
    const tile = emodnetTile(lat, lon);
    if (!tile) throw new Error("outside EMODnet coverage");
    const response = await get(
      erddapUrl(EMODNET_ERDDAP, tile.dataset, "elevation", bounds),
      15_000,
    );
    return parseErddapGrid(await response.json(), lat, lon);
  },
};

// --- KHOA water depth --------------------------------------------------------------
// The Korea Hydrographic and Oceanographic Agency's depth set for natural science and
// ocean models (the same points as its BADA 2024 file), through the Public Data Portal:
// soundings about 144 m apart over Korean waters, depth in metres from mean sea level.
// Needs a data.go.kr service key; the key's quota is 10,000 requests a day.

const KHOA_API =
  "https://apis.data.go.kr/1192136/waterDepth/GetWaterDepthApiService";
const KHOA_COVERAGE = {
  minLat: 30.3,
  maxLat: 38.5,
  minLon: 122.8,
  maxLon: 133,
};
const KHOA_SPACING_METERS = 144;
const KHOA_PAGE_SIZE = 300;
// A 2 km view is about 200 soundings, one page. The cap keeps a runaway from spending
// more than this many requests of the daily quota on one view.
const KHOA_MAX_PAGES = 10;
// Gridded every 16 m, each cell from the soundings within one and a half spacings. Far
// finer than the soundings, for the coastline from map data: a channel as narrow as
// the 32 m between Munseom and its islet still gets a row of water cells, so the two
// stay apart. A 2 km view is then 126 cells a side.
const KHOA_GRID_METERS = 16;
const KHOA_RADIUS_METERS = KHOA_SPACING_METERS * 1.5;
// When the map's coastline can't be had: the soundings sit on a lattice 144-155 m apart
// with none on land, so in open water no spot is farther than half a lattice diagonal
// (about 110 m) from one. A spot farther than this is a missing sounding: land.
const KHOA_LAND_BEYOND_METERS = 115;
// Soundings are asked for this far past the view on every side, so the view's own
// edges are not mistaken for land for want of the soundings just outside them. A 2 km
// view plus this margin is still about 250 soundings: one page.
const KHOA_FETCH_MARGIN_METERS = 180;

/** The service key as it goes in the URL: data.go.kr issues it encoded or decoded. */
function khoaKey(): string | null {
  const key = process.env.KHOA_API_KEY?.trim();
  if (!key) return null;
  return key.includes("%") ? key : encodeURIComponent(key);
}

async function khoaPage(
  key: string,
  bounds: Bounds,
  page: number,
): Promise<{ total: number; points: DepthPoint[] }> {
  // More than five decimals is refused with "invalid request parameter".
  const at = (value: number) => value.toFixed(5);
  // Assembled by hand so the already-encoded key is not encoded a second time.
  const url =
    `${KHOA_API}?serviceKey=${key}&type=json` +
    `&ymin=${at(bounds.south)}&ymax=${at(bounds.north)}` +
    `&xmin=${at(bounds.west)}&xmax=${at(bounds.east)}` +
    `&pageNo=${page}&numOfRows=${KHOA_PAGE_SIZE}`;
  const text = await (await get(new URL(url), 10_000)).text();
  // The portal answers a key or quota problem in XML whatever `type` asked for.
  if (text.trimStart().startsWith("<")) {
    const message = /<(returnAuthMsg|errMsg|resultMsg)>([^<]*)</.exec(
      text,
    )?.[2];
    throw new Error(`KHOA ${message ?? "answered XML"}`);
  }
  return parseKhoaPage(JSON.parse(text));
}

const khoa: Source = {
  id: "khoa",
  global: false,
  minKnownFraction: 0,
  holdsPlace: true,
  async probe(lat, lon) {
    const inside =
      lat >= KHOA_COVERAGE.minLat &&
      lat <= KHOA_COVERAGE.maxLat &&
      lon >= KHOA_COVERAGE.minLon &&
      lon <= KHOA_COVERAGE.maxLon;
    if (!inside) return null;
    if (!khoaKey()) throw new NotConfiguredError("KHOA_API_KEY is not set");
    return KHOA_SPACING_METERS;
  },
  async fetch(lat, lon, bounds) {
    const key = khoaKey();
    if (!key) throw new NotConfiguredError("KHOA_API_KEY is not set");
    const marginLat = KHOA_FETCH_MARGIN_METERS / 110540;
    const marginLon =
      KHOA_FETCH_MARGIN_METERS / (111320 * Math.cos((lat * Math.PI) / 180));
    const wider = {
      north: bounds.north + marginLat,
      south: bounds.south - marginLat,
      east: bounds.east + marginLon,
      west: bounds.west - marginLon,
    };
    const fetchPage = (page: number) => khoaPage(key, wider, page);
    const first = await fetchPage(1);
    const pages = Math.min(
      Math.ceil(first.total / KHOA_PAGE_SIZE),
      KHOA_MAX_PAGES,
    );
    const rest = await Promise.all(
      Array.from({ length: Math.max(0, pages - 1) }, (_, i) =>
        fetchPage(i + 2),
      ),
    );
    const points = [first, ...rest].flatMap((page) => page.points);
    if (points.length === 0)
      throw new NoCoverageError("no KHOA soundings here");
    // KHOA has soundings and nothing on land: the coastline comes from OpenStreetMap
    // and land heights from AWS Terrain Tiles, asked for at once.
    const [isWater, land] = await Promise.all([
      loadWaterTest(bounds),
      loadLandHeights(lat, lon, wider),
    ]);
    const deepest = Math.max(...points.map((point) => point.depth));
    // With neither terrain source, land is a low, flat rise: a tenth of the deepest
    // sounding, at least 2 m, enough to stand clear of the water surface.
    const flatLand = -Math.max(2, deepest * 0.1);
    const grid = gridPoints(
      points,
      bounds,
      KHOA_GRID_METERS,
      KHOA_RADIUS_METERS,
      lat,
      lon,
      {
        beyondMeters: KHOA_LAND_BEYOND_METERS,
        depth: land?.depth ?? flatLand,
        isWater: isWater ?? undefined,
      },
    );
    return { ...grid, landHeightFrom: land?.from ?? "flat" };
  },
};

// --- Land heights -------------------------------------------------------------------
// AWS Terrain Tiles (Tilezen's Terrarium tiles on AWS Open Data): keyless, about 9 m a
// pixel at Korea's latitude on zoom 14, from SRTM and other public elevation models.
// Their sea is not to be trusted (around Jeju it reads about -1,060 m), so they are only
// ever asked about cells the coastline already calls land. GMRT, coarser at about 60 m,
// stands in when the tiles can't be had.

const TERRAIN_TILES =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const TERRAIN_ZOOM = 14;
// Where the coastline calls a cell land but the terrain still reads sea level or
// below, the shore, the cell gets a token rise so it stands clear of the water.
const LAND_SHORE_METERS = 2;

/** A height for each land cell, as a negative depth, and which source gave it. */
async function loadLandHeights(
  lat: number,
  lon: number,
  bounds: Bounds,
): Promise<{
  depth: (lat: number, lon: number) => number;
  from: "aws-terrain" | "gmrt";
} | null> {
  const asDepth = (elevation: number | null) =>
    elevation !== null && elevation > LAND_SHORE_METERS
      ? -elevation
      : -LAND_SHORE_METERS;
  try {
    const tiles = await Promise.all(
      tilesCovering(bounds, TERRAIN_ZOOM).map(({ x, y }) => terrainTile(x, y)),
    );
    const sample = terrainSampler(tiles, TERRAIN_ZOOM);
    return { depth: (la, lo) => asDepth(sample(la, lo)), from: "aws-terrain" };
  } catch (error) {
    console.warn("Seafloor: no land heights from AWS Terrain Tiles", error);
  }
  try {
    const grid = await gmrt.fetch(lat, lon, bounds);
    return {
      depth: (la, lo) => {
        const depth = depthAt(grid, la, lo);
        return asDepth(depth === null ? null : -depth);
      },
      from: "gmrt",
    };
  } catch (error) {
    console.warn("Seafloor: no land heights from GMRT either", error);
    return null;
  }
}

async function terrainTile(x: number, y: number): Promise<TerrainTile> {
  const url = TERRAIN_TILES.replace("{z}", String(TERRAIN_ZOOM))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
  const png = Buffer.from(
    await (await get(new URL(url), 10_000)).arrayBuffer(),
  );
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const elevations = new Float32Array(info.width * info.height);
  for (let i = 0; i < elevations.length; i++) {
    elevations[i] = terrariumElevation(
      data[i * 3],
      data[i * 3 + 1],
      data[i * 3 + 2],
    );
  }
  return { x, y, size: info.width, elevations };
}

// --- Coastline from OpenStreetMap ---------------------------------------------------
// KHOA lists soundings and nothing on land, so where land is has to come from somewhere
// else. The bundled basemap's own vector tiles (OpenFreeMap, OpenStreetMap data in the
// OpenMapTiles schema) carry the sea as polygons, islands as their holes: the same
// coastline the 2D map draws. An instance configured with another basemap still gets
// this one's coastline.

const OPENFREEMAP_TILEJSON = "https://tiles.openfreemap.org/planet";
// The tiles' finest zoom: about 2 km a side at Korea's latitude, so a view touches at
// most four of them.
const COAST_ZOOM = 14;
// Sea, and harbour basins open to it. Lakes, ponds and rivers are land to a seascape.
const SEA_CLASSES = new Set(["ocean", "dock"]);

/** Water polygons for the box, or null if any tile couldn't be had. */
async function loadWaterTest(bounds: Bounds): Promise<WaterTest | null> {
  try {
    const tilejson = (await (
      await get(new URL(OPENFREEMAP_TILEJSON), 10_000)
    ).json()) as { tiles?: string[] };
    const template = tilejson.tiles?.[0];
    if (!template) return null;
    const tiles = await Promise.all(
      tilesCovering(bounds, COAST_ZOOM).map(async ({ x, y }) => {
        const url = template
          .replace("{z}", String(COAST_ZOOM))
          .replace("{x}", String(x))
          .replace("{y}", String(y));
        const buffer = await (await get(new URL(url), 10_000)).arrayBuffer();
        return waterTile(new Uint8Array(buffer), x, y);
      }),
    );
    return waterTest(tiles);
  } catch (error) {
    console.warn("Seafloor: no coastline from OpenFreeMap", error);
    return null;
  }
}

function waterTile(bytes: Uint8Array, x: number, y: number): WaterTile {
  const layer = new VectorTile(new PbfReader(bytes)).layers.water;
  const polygons: TilePolygon[] = [];
  // A tile with no water layer is all land.
  for (let i = 0; i < (layer?.length ?? 0); i++) {
    const feature = layer.feature(i);
    if (feature.type !== 3) continue;
    if (!SEA_CLASSES.has(String(feature.properties.class))) continue;
    polygons.push({ rings: feature.loadGeometry() });
  }
  return { z: COAST_ZOOM, x, y, extent: layer?.extent ?? 4096, polygons };
}

// --- GMRT --------------------------------------------------------------------------
// Global Multi-Resolution Topography: a global synthesis at its finest where multibeam
// surveys have been merged in. Asked for its maximum resolution.

const GMRT_GRID = "https://www.gmrt.org/services/GridServer";

const gmrt: Source = {
  id: "gmrt",
  global: true,
  async probe() {
    return 60;
  },
  async fetch(lat, lon, bounds) {
    const url = new URL(GMRT_GRID);
    url.searchParams.set("north", bounds.north.toFixed(6));
    url.searchParams.set("south", bounds.south.toFixed(6));
    url.searchParams.set("east", bounds.east.toFixed(6));
    url.searchParams.set("west", bounds.west.toFixed(6));
    url.searchParams.set("format", "esriascii");
    url.searchParams.set("resolution", "max");
    return parseEsriAscii(await (await get(url, 15_000)).text(), lat, lon);
  },
};

// --- ETOPO 2022 --------------------------------------------------------------------
// NOAA's global relief model at 15 arc-seconds, about 450 m: the last resort, and the
// one that answers everywhere. Two ERDDAP servers carry it.

const ETOPO_HOSTS = [
  "https://coastwatch.pfeg.noaa.gov/erddap/griddap",
  "https://oceanwatch.pifsc.noaa.gov/erddap/griddap",
];
// Asked for at least this span, so a small box still gets a few of its coarse cells.
const ETOPO_MIN_SPAN_METERS = 10_000;

const etopo: Source = {
  id: "etopo2022",
  global: true,
  async probe() {
    return 450;
  },
  async fetch(lat, lon, bounds) {
    const span = Math.max(
      (bounds.north - bounds.south) * 110540,
      ETOPO_MIN_SPAN_METERS,
    );
    const wide = boundsAround(lat, lon, span);
    let lastError: unknown;
    for (const host of ETOPO_HOSTS) {
      try {
        const response = await get(
          erddapUrl(host, "ETOPO_2022_v1_15s", "z", wide),
          15_000,
        );
        return parseErddapGrid(await response.json(), lat, lon);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  },
};

// The order sources are preferred in, before cell size reorders them.
const SOURCES: Source[] = [noaaDem, emodnet, khoa, gmrt, etopo];

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The best seafloor grid for a square `spanMeters` across around a point, with a
 * record of every source considered and why it was or was not used.
 *
 * Cached for days per point and span, except a failure: no source reachable is
 * worth asking again in a minute.
 */
export async function resolveSeafloor(
  lat: number,
  lon: number,
  spanMeters: number,
): Promise<SeafloorResult> {
  "use cache";

  // A dive site needs no more, and it keeps every source's request small.
  const bounds = boundsAround(
    lat,
    lon,
    Math.min(spanMeters, SEAFLOOR_MAX_SPAN_METERS),
  );
  const attempts: SeafloorAttempt[] = [];

  const probed = await Promise.all(
    SOURCES.map(async (source) => {
      try {
        return { source, cell: await source.probe(lat, lon) };
      } catch (error) {
        return {
          source,
          cell: null,
          error: errorText(error),
          unconfigured: error instanceof NotConfiguredError,
        };
      }
    }),
  );
  let failures = 0;
  const candidates: {
    source: Source;
    cellSizeMeters: number;
    holdsPlace?: boolean;
  }[] = [];
  for (const { source, cell, error, unconfigured } of probed as {
    source: Source;
    cell: number | null;
    error?: string;
    unconfigured?: boolean;
  }[]) {
    if (unconfigured) {
      attempts.push({
        source: source.id,
        outcome: "not configured",
        detail: error,
      });
    } else if (error) {
      failures++;
      attempts.push({ source: source.id, outcome: "failed", detail: error });
    } else if (cell === null) {
      attempts.push({ source: source.id, outcome: "no coverage" });
    } else {
      candidates.push({
        source,
        cellSizeMeters: cell,
        holdsPlace: source.holdsPlace,
      });
    }
  }

  let globalSaysDry = false;
  const ordered = orderByCellSize(candidates);
  for (let i = 0; i < ordered.length; i++) {
    const { source, cellSizeMeters } = ordered[i];
    const attempt = (
      outcome: SeafloorAttempt["outcome"],
      detail?: string,
    ): SeafloorAttempt => ({
      source: source.id,
      outcome,
      cellSizeMeters,
      detail,
    });

    let grid: SeascapeGrid;
    try {
      grid = cropToBounds(await source.fetch(lat, lon, bounds), bounds);
    } catch (error) {
      if (error instanceof NoCoverageError) {
        attempts.push(attempt("no coverage", error.message));
      } else if (error instanceof NotConfiguredError) {
        attempts.push(attempt("not configured", error.message));
      } else {
        failures++;
        attempts.push(attempt("failed", errorText(error)));
      }
      continue;
    }

    if (grid.rows < MIN_CELLS || grid.cols < MIN_CELLS) {
      attempts.push(
        attempt("too coarse", `${grid.cols} × ${grid.rows} cells at this span`),
      );
      continue;
    }
    const known = knownFraction(grid);
    if (known < (source.minKnownFraction ?? MIN_KNOWN_FRACTION)) {
      attempts.push(
        attempt(
          "too little data",
          `${Math.round(known * 100)}% of cells have a reading`,
        ),
      );
      continue;
    }
    const wet = wetFraction(grid);
    if (wet < MIN_WET_FRACTION) {
      if (source.global) globalSaysDry = true;
      attempts.push(
        attempt("mostly land", `${Math.round(wet * 100)}% of cells are water`),
      );
      continue;
    }

    const landNote =
      (grid.landFrom === "openstreetmap"
        ? " · coastline from OpenStreetMap"
        : grid.landFrom === "soundings"
          ? " · coastline from gaps between soundings"
          : "") +
      (grid.landHeightFrom === "aws-terrain"
        ? " · land heights from AWS Terrain Tiles"
        : grid.landHeightFrom === "gmrt"
          ? " · land heights from GMRT"
          : grid.landHeightFrom === "flat"
            ? " · land drawn flat"
            : "");
    attempts.push(
      attempt(
        "used",
        `${grid.cols} × ${grid.rows} cells, ~${Math.round(grid.resolutionMeters)} m${landNote}`,
      ),
    );
    for (const rest of ordered.slice(i + 1)) {
      attempts.push({
        source: rest.source.id,
        outcome: "not needed",
        cellSizeMeters: rest.cellSizeMeters,
      });
    }
    cacheLife("days");
    return {
      status: "ok",
      source: source.id,
      grid: downsample(grid, MAX_GRID_DIM),
      attempts,
    };
  }

  if (globalSaysDry && failures === 0) {
    cacheLife("days");
    return { status: "dry", attempts };
  }
  cacheLife("seconds");
  return { status: "failed", attempts };
}
