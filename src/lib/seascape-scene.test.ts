import { describe, expect, it } from "vitest";
import type { SeascapeGrid } from "@/lib/seascape-grid";
import {
  buildSeascapeScene,
  chainSegments,
  deepestCorner,
  depthAt,
  niceStep,
  surfaceDepth,
  verticalExaggeration,
} from "@/lib/seascape-scene";

describe("niceStep", () => {
  it("rounds up to 1, 2 or 5 times a power of ten", () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.3)).toBe(2);
    expect(niceStep(6.6)).toBe(10);
    expect(niceStep(42)).toBe(50);
  });
});

describe("verticalExaggeration", () => {
  it("stretches a shallow slope, up to 4×", () => {
    expect(verticalExaggeration(100, 8000)).toBe(4);
  });

  it("never flattens a steep one", () => {
    expect(verticalExaggeration(4000, 8000)).toBe(1);
  });

  it("lands in between when the slope asks for it", () => {
    expect(verticalExaggeration(1000, 8000)).toBeCloseTo(2.8);
  });
});

describe("surfaceDepth", () => {
  it("draws no reading at the waterline and caps land at the max depth", () => {
    expect(surfaceDepth(null, 100)).toBe(0);
    expect(surfaceDepth(-160, 100)).toBe(-100);
    expect(surfaceDepth(-73, 100)).toBe(-73);
    expect(surfaceDepth(42, 100)).toBe(42);
  });
});

// A 3 × 3 tile, about 2 km a side, deepening from 10 m in the north to 30 m in the south.
const grid: SeascapeGrid = {
  originLat: 32.99,
  originLon: 125.99,
  cellLat: 0.01,
  cellLon: 0.01,
  rows: 3,
  cols: 3,
  depths: [30, 30, 30, 20, 20, 20, 10, 10, 10],
  resolutionMeters: 930,
  centerLat: 33,
  centerLon: 126,
};

describe("depthAt", () => {
  it("interpolates between rows", () => {
    expect(depthAt(grid, 32.995, 126)).toBeCloseTo(25);
  });

  it("is null off the grid", () => {
    expect(depthAt(grid, 40, 126)).toBeNull();
  });
});

describe("buildSeascapeScene", () => {
  const scene = buildSeascapeScene(grid);

  it("makes one vertex per node and two triangles per cell", () => {
    expect(scene.positions.length).toBe(9 * 3);
    expect(scene.indices.length).toBe(4 * 6);
  });

  it("puts north at -z and the deep south lowest", () => {
    // Row 0 is the south: positive z and the lowest y.
    expect(scene.positions[2]).toBeGreaterThan(0);
    expect(scene.positions[1]).toBeLessThan(scene.positions[6 * 3 + 1]);
  });

  it("draws a contour at every step between the shallowest and deepest water", () => {
    // A 30 m max depth gives a 2 m step. Every fifth level is major, so 20 m is one.
    expect(scene.contourStep).toBe(2);
    expect(scene.minorContours.length).toBeGreaterThan(0);
    expect(scene.majorContours.length).toBeGreaterThan(0);
  });

  it("marks the pin's seabed when there is water under it", () => {
    expect(scene.pin.seabedY).not.toBeNull();
    expect(scene.hasLand).toBe(false);
  });

  it("labels a contour at five candidate spots along it", () => {
    const contours = scene.labels.filter(
      (label) => label.kind === "major" || label.kind === "minor",
    );
    expect(contours.map((label) => label.text)).toContain("20 m");
    for (const label of contours) expect(label.anchors).toHaveLength(5);
  });

  it("titles the axes and ticks them at round numbers, skipping the corner's 0", () => {
    const titles = scene.labels.filter((label) => label.kind === "title");
    expect(titles.map((label) => label.text)).toEqual([
      "Distance (m)",
      "Distance (m)",
      "Depth (m)",
    ]);
    const ticks = scene.labels.filter((label) => label.kind === "tick");
    // 1.9 km east-west and 2.2 km north-south give 500 m steps; 30 m deep, 10 m.
    expect(ticks.map((label) => label.text)).toEqual([
      "500",
      "1000",
      "1500",
      "500",
      "1000",
      "1500",
      "2000",
      "0",
      "10",
      "20",
      "30",
    ]);
    // Three axis lines and one tick per label, two points of xyz each.
    expect(scene.axisLines).toHaveLength(3 * 6);
    expect(scene.axisTicks).toHaveLength(ticks.length * 6);
  });
});

describe("chainSegments", () => {
  it("joins segments that share an end, whichever way round they were traced", () => {
    const lines = chainSegments([
      [0, 1, 0, 2],
      [0, 0, 0, 1],
      [0, 3, 0, 2],
      [5, 5, 6, 6],
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
  });
});

describe("deepestCorner", () => {
  // 3 × 3, row 0 the south: south-west, south, south-east, ..., north-east last.
  const tile = (depths: (number | null)[]): SeascapeGrid => ({
    ...grid,
    depths,
  });

  it("picks the deepest corner, not a deeper point along an edge or inside", () => {
    // The middle of the east edge (60) and the centre (90) are deeper, but not corners.
    const corner = deepestCorner(tile([5, 6, 30, 5, 90, 60, 8, 6, 7]));
    expect(corner).toMatchObject({ row: 0, col: 2, depth: 30 });
  });

  it("points out of the tile diagonally", () => {
    // North-west corner: west is -x, north is -z.
    const corner = deepestCorner(tile([5, 6, 7, 5, 9, 8, 40, 6, 7]));
    expect(corner?.row).toBe(2);
    expect(corner?.outX).toBeCloseTo(-Math.SQRT1_2);
    expect(corner?.outZ).toBeCloseTo(-Math.SQRT1_2);
  });

  it("is null when every corner is land or empty", () => {
    expect(
      deepestCorner(tile([-1, 50, -1, 50, 50, 50, null, 50, -1])),
    ).toBeNull();
  });
});
