import { describe, expect, it } from "vitest";
import {
  boundsAround,
  cropToBounds,
  downsample,
  knownFraction,
  parseEsriAscii,
  wetFraction,
  type SeascapeGrid,
} from "@/lib/seascape-grid";

// Three columns, two rows, listed north first as the format does. -9999 is no reading.
const ASCII = `ncols 3
nrows 2
xllcorner 126.0
yllcorner 33.0
cellsize 0.01
nodata_value -9999
-10 -20 5
-30 -9999 -40
`;

describe("parseEsriAscii", () => {
  const grid = parseEsriAscii(ASCII, 33.01, 126.015);

  it("stores rows south first", () => {
    // The file's last line is the southern row.
    expect(grid.depths.slice(0, 3)).toEqual([30, null, 40]);
    expect(grid.depths.slice(3, 6)).toEqual([10, 20, -5]);
  });

  it("flips elevation into depth, keeping land as negative depth", () => {
    expect(grid.depths[5]).toBe(-5);
  });

  it("puts the origin at the centre of the south-west cell", () => {
    expect(grid.originLat).toBeCloseTo(33.005);
    expect(grid.originLon).toBeCloseTo(126.005);
    expect(grid.rows).toBe(2);
    expect(grid.cols).toBe(3);
  });

  it("refuses a grid with too few values", () => {
    expect(() =>
      parseEsriAscii(ASCII.replace("-30 -9999 -40", "-30"), 33, 126),
    ).toThrow(/expected 6/);
  });
});

describe("downsample", () => {
  const grid: SeascapeGrid = {
    originLat: 0,
    originLon: 0,
    cellLat: 1,
    cellLon: 1,
    rows: 4,
    cols: 4,
    depths: [1, 3, null, null, 5, 7, null, null, 2, 2, 4, 4, 2, 2, 4, null],
    resolutionMeters: 100,
    centerLat: 1.5,
    centerLon: 1.5,
  };

  it("averages blocks and ignores empty cells", () => {
    const small = downsample(grid, 2);
    expect(small.rows).toBe(2);
    expect(small.cols).toBe(2);
    expect(small.depths).toEqual([4, null, 2, 4]);
  });

  it("moves the origin to the first block's centre and widens the cells", () => {
    const small = downsample(grid, 2);
    expect(small.originLat).toBe(0.5);
    expect(small.cellLat).toBe(2);
    expect(small.resolutionMeters).toBe(200);
  });

  it("leaves a grid that already fits alone", () => {
    expect(downsample(grid, 4)).toBe(grid);
  });
});

describe("boundsAround", () => {
  it("is a square of the given span around the point", () => {
    const bounds = boundsAround(33, 126, 8000);
    expect((bounds.north - bounds.south) * 110540).toBeCloseTo(8000);
    expect(
      (bounds.east - bounds.west) * 111320 * Math.cos((33 * Math.PI) / 180),
    ).toBeCloseTo(8000);
  });
});

describe("cropToBounds", () => {
  // Ten cells a side, one degree apart, centred on 4.5.
  const grid: SeascapeGrid = {
    originLat: 0,
    originLon: 0,
    cellLat: 1,
    cellLon: 1,
    rows: 10,
    cols: 10,
    depths: Array.from({ length: 100 }, (_, i) => i),
    resolutionMeters: 100,
    centerLat: 4.5,
    centerLon: 4.5,
  };

  it("keeps only the cells whose centres fall inside", () => {
    const cropped = cropToBounds(grid, {
      north: 5,
      south: 3,
      east: 6,
      west: 4,
    });
    expect(cropped.rows).toBe(3);
    expect(cropped.cols).toBe(3);
    expect(cropped.originLat).toBe(3);
    expect(cropped.originLon).toBe(4);
    expect(cropped.depths.slice(0, 3)).toEqual([34, 35, 36]);
  });

  it("leaves a grid that is no more than 10% wider alone", () => {
    expect(cropToBounds(grid, { north: 9, south: 0, east: 9, west: 0 })).toBe(
      grid,
    );
  });
});

describe("knownFraction and wetFraction", () => {
  const grid = {
    depths: [10, -2, null, 5],
  } as SeascapeGrid;

  it("counts readings among all cells, and water among readings", () => {
    expect(knownFraction(grid)).toBe(0.75);
    expect(wetFraction(grid)).toBeCloseTo(2 / 3);
  });
});
