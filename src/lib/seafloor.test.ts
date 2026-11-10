import { describe, expect, it } from "vitest";
import {
  cellSizeMeters,
  gridPoints,
  NoCoverageError,
  orderByCellSize,
  parseErddapGrid,
  parseFloat32Tiff,
  parseKhoaPage,
  tilePosition,
  terrainSampler,
  terrariumElevation,
  tilesCovering,
  waterTest,
  type DepthPoint,
} from "@/lib/seafloor";

describe("orderByCellSize", () => {
  const order = (cells: number[]) =>
    orderByCellSize(cells.map((cellSizeMeters) => ({ cellSizeMeters }))).map(
      (candidate) => candidate.cellSizeMeters,
    );

  it("keeps the preferred order when no source is more than twice as fine", () => {
    // EMODnet's 115 m stays ahead of GMRT's 60 m.
    expect(order([115, 60, 450])).toEqual([115, 60, 450]);
  });

  it("never moves anything past a source that holds its place", () => {
    // KHOA's 144 m survey data stays ahead of GMRT's nominal 60 m.
    const ordered = orderByCellSize([
      { cellSizeMeters: 144, holdsPlace: true, id: "khoa" },
      { cellSizeMeters: 60, id: "gmrt" },
      { cellSizeMeters: 450, id: "etopo" },
    ]);
    expect(ordered.map((candidate) => candidate.id)).toEqual([
      "khoa",
      "gmrt",
      "etopo",
    ]);
  });

  it("moves a much finer source ahead", () => {
    expect(order([115, 3.4, 60, 450])).toEqual([3.4, 115, 60, 450]);
    expect(order([450, 60])).toEqual([60, 450]);
  });
});

describe("cellSizeMeters", () => {
  it("reports the coarser axis", () => {
    // 15 arc-seconds is about 460 m north-south anywhere, less east-west away from the equator.
    expect(cellSizeMeters(1 / 240, 1 / 240, 60)).toBeCloseTo(460.6, 0);
  });
});

describe("parseErddapGrid", () => {
  const body = {
    table: {
      columnNames: ["latitude", "longitude", "elevation"],
      rows: [
        [10.0, 20.0, -5],
        [10.0, 20.5, -6],
        [10.5, 20.0, null],
        [10.5, 20.5, 3],
      ],
    },
  };

  it("lays the cells out south first and flips elevation into depth", () => {
    const grid = parseErddapGrid(body, 10.25, 20.25);
    expect(grid.rows).toBe(2);
    expect(grid.cols).toBe(2);
    expect(grid.depths).toEqual([5, 6, null, -3]);
    expect(grid.originLat).toBe(10);
    expect(grid.cellLon).toBe(0.5);
  });

  it("refuses an answer with no grid in it", () => {
    expect(() =>
      parseErddapGrid({ table: { rows: [[1, 2, 3]] } }, 0, 0),
    ).toThrow();
    expect(() => parseErddapGrid({}, 0, 0)).toThrow();
  });
});

/** A little-endian, uncompressed, single-strip float32 TIFF, rows north first. */
function stripTiff(
  width: number,
  height: number,
  values: number[],
): ArrayBuffer {
  const entries: [number, number, number][] = [
    [256, 3, width],
    [257, 3, height],
    [258, 3, 32],
    [259, 3, 1],
    [273, 4, 0], // strip offset, filled in below
    [277, 3, 1],
    [278, 3, height],
    [279, 4, width * height * 4],
    [339, 3, 3],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const dataOffset = 8 + ifdSize;
  const buffer = new ArrayBuffer(dataOffset + values.length * 4);
  const view = new DataView(buffer);
  view.setUint16(0, 0x4949);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, value], i) => {
    const at = 10 + i * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, 1, true);
    const stored = tag === 273 ? dataOffset : value;
    if (type === 3) view.setUint16(at + 8, stored, true);
    else view.setUint32(at + 8, stored, true);
  });
  values.forEach((value, i) =>
    view.setFloat32(dataOffset + i * 4, value, true),
  );
  return buffer;
}

describe("parseFloat32Tiff", () => {
  const bounds = { north: 2, south: 0, east: 3, west: 0 };

  it("reads the strip south first, flips elevation, and empties no-data", () => {
    // North row first, as the file stores it.
    const buffer = stripTiff(3, 2, [-1, -2, NaN, -10, 4, -3.4e38]);
    const grid = parseFloat32Tiff(buffer, bounds, 1, 1.5);
    expect(grid.depths).toEqual([10, -4, null, 1, 2, null]);
  });

  it("puts the origin at the centre of the south-west pixel", () => {
    const grid = parseFloat32Tiff(
      stripTiff(3, 2, [0, 0, 0, 0, 0, 0]),
      bounds,
      1,
      1.5,
    );
    expect(grid.originLat).toBe(0.5);
    expect(grid.originLon).toBe(0.5);
    expect(grid.cellLat).toBe(1);
  });

  it("refuses anything that is not a little-endian TIFF", () => {
    expect(() => parseFloat32Tiff(new ArrayBuffer(16), bounds, 0, 0)).toThrow(
      /TIFF/,
    );
  });
});

describe("parseKhoaPage", () => {
  it("reads the soundings and the total", () => {
    const page = parseKhoaPage({
      header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" },
      body: {
        items: {
          item: [
            { lat: 33.2009, lot: 126.4915, dpwt: 86.8 },
            { lat: 33.201, lot: 126.4931, dpwt: 87.55 },
          ],
        },
        totalCount: 677,
      },
    });
    expect(page.total).toBe(677);
    expect(page.points).toEqual([
      { lat: 33.2009, lon: 126.4915, depth: 86.8 },
      { lat: 33.201, lon: 126.4931, depth: 87.55 },
    ]);
  });

  it("takes a single sounding that arrives as an object", () => {
    const page = parseKhoaPage({
      header: { resultCode: "00" },
      body: { items: { item: { lat: 1, lot: 2, dpwt: 3 } }, totalCount: 1 },
    });
    expect(page.points).toEqual([{ lat: 1, lon: 2, depth: 3 }]);
  });

  it("treats 'no data' as a decline and anything else as an error", () => {
    expect(() =>
      parseKhoaPage({
        header: { resultCode: "03", resultMsg: "NODATA_ERROR" },
      }),
    ).toThrow(NoCoverageError);
    expect(() =>
      parseKhoaPage({
        header: {
          resultCode: "22",
          resultMsg: "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR",
        },
      }),
    ).toThrow(/22 LIMITED/);
  });
});

describe("gridPoints", () => {
  // A box a little over 300 m a side at the equator, gridded every 100 m: 4 × 4 cells.
  const bounds = { south: 0, north: 0.0028, west: 0, east: 0.0028 };

  it("puts a sounding's depth on the cell it sits on", () => {
    const grid = gridPoints(
      [{ lat: 0, lon: 0, depth: 12 }],
      bounds,
      100,
      150,
      0,
      0,
    );
    expect(grid.depths[0]).toBe(12);
  });

  it("weights nearby soundings by distance", () => {
    const grid = gridPoints(
      [
        { lat: 0, lon: 0.0003, depth: 10 },
        { lat: 0, lon: 0.0015, depth: 40 },
      ],
      bounds,
      100,
      150,
      0,
      0,
    );
    // The cell 100 m east sits about 33 m from the first and 67 m from the second.
    const value = grid.depths[1] as number;
    expect(value).toBeGreaterThan(10);
    expect(value).toBeLessThan(25);
  });

  it("leaves cells far from every sounding empty", () => {
    const grid = gridPoints(
      [{ lat: 0, lon: 0, depth: 12 }],
      bounds,
      100,
      150,
      0,
      0,
    );
    expect(grid.depths[grid.depths.length - 1]).toBeNull();
    expect(grid.rows).toBe(4);
    expect(grid.cols).toBe(4);
  });
});

describe("gridPoints with a land rule", () => {
  // A lattice of soundings 144 m apart, 20 m deep, with the middle one missing: a rock.
  const spacing = 144;
  const metresPerDegLon = 111320; // at the equator
  const points: DepthPoint[] = [];
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      if (i === 0 && j === 0) continue;
      points.push({
        lat: (i * spacing) / 110540,
        lon: (j * spacing) / metresPerDegLon,
        depth: 20,
      });
    }
  }
  const half = (2 * spacing) / 110540;
  const bounds = { south: -half, north: half, west: -half, east: half };
  const grid = gridPoints(points, bounds, 72, 216, 0, 0, {
    beyondMeters: 115,
    depth: -3,
  });
  const at = (northMeters: number, eastMeters: number) => {
    const r = Math.round((northMeters + 2 * spacing) / 72);
    const c = Math.round((eastMeters + 2 * spacing) / 72);
    return grid.depths[r * grid.cols + c];
  };

  it("makes the spot of a missing sounding land, even a single node", () => {
    expect(at(0, 0)).toBe(-3);
  });

  it("keeps open water between soundings as water", () => {
    // Halfway between two soundings, and at the middle of a lattice square.
    expect(at(144, 72)).toBeCloseTo(20);
    expect(at(-216, -216)).toBeCloseTo(20);
  });
});

describe("tiles", () => {
  it("puts a point in the right Web Mercator tile", () => {
    // Munseom, off Seogwipo, at zoom 14: tile 13952 / 6587.
    const position = tilePosition(33.22769, 126.56571, 14);
    expect(Math.floor(position.x)).toBe(13952);
    expect(Math.floor(position.y)).toBe(6587);
  });

  it("lists every tile a box touches", () => {
    const tiles = tilesCovering(
      { north: 33.2367, south: 33.2187, east: 126.5765, west: 126.555 },
      14,
    );
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    expect(tiles.length).toBeLessThanOrEqual(4);
  });
});

describe("waterTest", () => {
  // One tile at zoom 1 (x 1, y 0: the north-east quarter of the world), all sea except
  // a square island in its middle, drawn as a hole.
  const test = waterTest([
    {
      z: 1,
      x: 1,
      y: 0,
      extent: 100,
      polygons: [
        {
          rings: [
            [
              { x: 0, y: 0 },
              { x: 100, y: 0 },
              { x: 100, y: 100 },
              { x: 0, y: 100 },
            ],
            [
              { x: 40, y: 40 },
              { x: 40, y: 60 },
              { x: 60, y: 60 },
              { x: 60, y: 40 },
            ],
          ],
        },
      ],
    },
  ]);

  it("is water in the sea, land in the island, and unknown off the tile", () => {
    expect(test(60, 30)).toBe(true);
    // The tile's middle, at x 50 / y 50 of 100.
    expect(test(66.51326, 90)).toBe(false);
    expect(test(10, -30)).toBeNull();
  });
});

describe("gridPoints with a coastline", () => {
  // Soundings 20 m deep on a 144 m lattice, all present: no gap marks any land.
  const points: DepthPoint[] = [];
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      points.push({
        lat: (i * 144) / 110540,
        lon: (j * 144) / 111320,
        depth: 20,
      });
    }
  }
  const half = 288 / 110540;
  const bounds = { south: -half, north: half, west: -half, east: half };
  // The map puts a small island just north-east of the middle, nowhere near a gap.
  const isWater = (lat: number, lon: number) =>
    !(lat > 0 && lat < 40 / 110540 && lon > 0 && lon < 40 / 111320);

  it("draws the map's island even where every sounding is present", () => {
    const grid = gridPoints(points, bounds, 36, 216, 0, 0, {
      beyondMeters: 115,
      depth: -3,
      isWater,
    });
    expect(grid.landFrom).toBe("openstreetmap");
    expect(grid.depths.filter((depth) => depth === -3).length).toBeGreaterThan(
      0,
    );
    // The south-west corner is open water.
    expect(grid.depths[0]).toBeCloseTo(20);
  });

  it("falls back to the gaps between soundings without a coastline", () => {
    const grid = gridPoints(points, bounds, 36, 216, 0, 0, {
      beyondMeters: 115,
      depth: -3,
    });
    expect(grid.landFrom).toBe("soundings");
    expect(grid.depths.every((depth) => depth !== -3)).toBe(true);
  });
});

describe("gridPoints with land heights", () => {
  it("asks the height function for each land cell", () => {
    const points: DepthPoint[] = [{ lat: 0, lon: 0, depth: 20 }];
    const half = 200 / 110540;
    const grid = gridPoints(
      points,
      { south: -half, north: half, west: -half, east: half },
      100,
      150,
      0,
      0,
      {
        beyondMeters: 115,
        // Land rising to the east: 1 m higher per 0.001° of longitude.
        depth: (_lat, lon) => -(5 + lon * 1000),
      },
    );
    // The corners are far from the one sounding, so land, at their own heights.
    const west = grid.depths[0] as number;
    const east = grid.depths[grid.cols - 1] as number;
    expect(west).toBeLessThan(0);
    expect(east).toBeLessThan(west);
  });
});

describe("terrariumElevation", () => {
  it("decodes Terrarium's red, green and blue into metres", () => {
    expect(terrariumElevation(128, 0, 0)).toBe(0);
    expect(terrariumElevation(128, 73, 76.8)).toBeCloseTo(73.3);
    expect(terrariumElevation(127, 255, 0)).toBe(-1);
  });
});

describe("terrainSampler", () => {
  // One 2 × 2 zoom-0 tile (the whole world), rising from 0 m in the west to 100 m in the east.
  const sample = terrainSampler(
    [{ x: 0, y: 0, size: 2, elevations: new Float32Array([0, 100, 0, 100]) }],
    0,
  );

  it("interpolates between pixel centres", () => {
    // Longitude 0 is halfway between the two pixel centres (at -90° and 90°).
    expect(sample(0, 0)).toBeCloseTo(50);
  });

  it("is null where a pixel it needs is on no tile", () => {
    expect(sample(0, 179)).toBeNull();
  });
});
