import { describe, expect, it } from "vitest";
import { toSeascapeGrid } from "@/lib/seascape-grid";

describe("toSeascapeGrid", () => {
  it("carries the API's grid over field for field, depths untouched", () => {
    const depths = [82.63, null, -12.5, 3];
    const grid = toSeascapeGrid({
      origin_lat: 33.2,
      origin_lon: 126.5,
      cell_lat: 0.001,
      cell_lon: 0.002,
      rows: 2,
      cols: 2,
      depths,
      resolution_meters: 16,
      center_lat: 33.2251,
      center_lon: 126.5683,
      land_from: "openstreetmap",
      land_height_from: "aws_terrain",
    });

    expect(grid).toEqual({
      originLat: 33.2,
      originLon: 126.5,
      cellLat: 0.001,
      cellLon: 0.002,
      rows: 2,
      cols: 2,
      depths,
      resolutionMeters: 16,
      centerLat: 33.2251,
      centerLon: 126.5683,
    });
  });
});
