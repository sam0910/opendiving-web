import { describe, expect, it } from "vitest";
import type { SeafloorAttempt, SeafloorGrid } from "@/lib/api/seafloor";
import {
  attemptLine,
  lookUpErrorText,
  noGridText,
  sortAttempts,
} from "@/lib/seafloor";

const NONE = {
  cell_size_meters: null,
  cols: null,
  rows: null,
  resolution_meters: null,
  known_fraction: null,
  wet_fraction: null,
  error: null,
};

const attempt = (
  fields: Pick<SeafloorAttempt, "source" | "outcome"> &
    Partial<SeafloorAttempt>,
): SeafloorAttempt => ({ ...NONE, ...fields });

// Jeju's answer from the API, without its depths.
const KHOA_GRID: SeafloorGrid = {
  origin_lat: 33.216,
  origin_lon: 126.557,
  cell_lat: 0.000145,
  cell_lon: 0.000172,
  rows: 126,
  cols: 125,
  depths: [],
  resolution_meters: 16,
  center_lat: 33.2251,
  center_lon: 126.5683,
  land_from: "openstreetmap",
  land_height_from: "aws_terrain",
};

// The lines the dialog showed when the web resolved the seafloor itself; the API's
// numbers have to come out as the same words.
describe("attemptLine", () => {
  it("describes the used source's grid before averaging, and where its land came from", () => {
    expect(
      attemptLine(
        attempt({
          source: "khoa",
          outcome: "used",
          cell_size_meters: 144,
          cols: 125,
          rows: 126,
          resolution_meters: 16,
          known_fraction: 1,
          wet_fraction: 0.96,
        }),
        KHOA_GRID,
      ),
    ).toBe(
      "KHOA (~144 m native): used · 125 × 126 cells, ~16 m · coastline from OpenStreetMap · land heights from AWS Terrain Tiles",
    );
  });

  it("says nothing about land for a source that measures its own", () => {
    expect(
      attemptLine(
        attempt({
          source: "noaa_dem",
          outcome: "used",
          cell_size_meters: 10,
          cols: 160,
          rows: 160,
          resolution_meters: 12.6,
        }),
        { ...KHOA_GRID, land_from: null, land_height_from: null },
      ),
    ).toBe("NOAA DEM (~10 m native): used · 160 × 160 cells, ~13 m");
  });

  it("names the other ways KHOA's land can be drawn", () => {
    const used = attempt({
      source: "khoa",
      outcome: "used",
      cols: 125,
      rows: 126,
      resolution_meters: 16,
    });
    expect(
      attemptLine(used, {
        ...KHOA_GRID,
        land_from: "soundings",
        land_height_from: "gmrt",
      }),
    ).toBe(
      "KHOA: used · 125 × 126 cells, ~16 m · coastline from gaps between soundings · land heights from GMRT",
    );
    expect(attemptLine(used, { ...KHOA_GRID, land_height_from: "flat" })).toBe(
      "KHOA: used · 125 × 126 cells, ~16 m · coastline from OpenStreetMap · land drawn flat",
    );
  });

  it("gives the reason a source was passed over", () => {
    expect(
      attemptLine(
        attempt({
          source: "emodnet",
          outcome: "too_little_data",
          cell_size_meters: 115,
          known_fraction: 0.004,
        }),
        null,
      ),
    ).toBe(
      "EMODnet (~115 m native): too little data · 0% of cells have a reading",
    );
    expect(
      attemptLine(
        attempt({
          source: "gmrt",
          outcome: "mostly_land",
          cell_size_meters: 60,
          wet_fraction: 0.075,
        }),
        null,
      ),
    ).toBe("GMRT (~60 m native): mostly land · 8% of cells are water");
    expect(
      attemptLine(
        attempt({
          source: "etopo2022",
          outcome: "too_coarse",
          cell_size_meters: 450,
          cols: 6,
          rows: 4,
        }),
        null,
      ),
    ).toBe("ETOPO 2022 (~450 m native): too coarse · 6 × 4 cells at this span");
  });

  it("writes a fine native cell size to a tenth of a metre", () => {
    expect(
      attemptLine(
        attempt({
          source: "noaa_dem",
          outcome: "not_needed",
          cell_size_meters: 3.4,
        }),
        null,
      ),
    ).toBe("NOAA DEM (~3.4 m native): not needed");
  });

  it("shows a failed source's error, and the setting KHOA is missing", () => {
    expect(
      attemptLine(
        attempt({ source: "gmrt", outcome: "failed", error: "HTTP 502" }),
        null,
      ),
    ).toBe("GMRT: failed · HTTP 502");
    expect(
      attemptLine(attempt({ source: "khoa", outcome: "not_configured" }), null),
    ).toBe("KHOA: not set up · KHOA_API_KEY is not set");
  });

  it("tells a source with no data in its box from one that doesn't cover the spot", () => {
    expect(
      attemptLine(attempt({ source: "emodnet", outcome: "no_coverage" }), null),
    ).toBe("EMODnet: doesn't cover this spot");
    expect(
      attemptLine(
        attempt({
          source: "khoa",
          outcome: "no_coverage",
          cell_size_meters: 144,
        }),
        null,
      ),
    ).toBe(
      "KHOA (~144 m native): doesn't cover this spot · no KHOA data in this area",
    );
  });
});

describe("sortAttempts", () => {
  it("lists the sources in the API's preferred order, whatever order they were tried in", () => {
    const sorted = sortAttempts([
      attempt({ source: "gmrt", outcome: "used" }),
      attempt({ source: "etopo2022", outcome: "not_needed" }),
      attempt({ source: "noaa_dem", outcome: "too_little_data" }),
      attempt({ source: "khoa", outcome: "no_coverage" }),
      attempt({ source: "emodnet", outcome: "no_coverage" }),
    ]);
    expect(sorted.map((a) => a.source)).toEqual([
      "noaa_dem",
      "emodnet",
      "khoa",
      "gmrt",
      "etopo2022",
    ]);
  });
});

describe("noGridText", () => {
  it("tells land from a failure", () => {
    expect(noGridText("dry")).toBe(
      "Every source puts this spot on land. Double-click somewhere in the water.",
    );
    expect(noGridText("failed")).toBe(
      "No source gave seafloor data here. Try again in a moment.",
    );
  });
});

describe("lookUpErrorText", () => {
  const status = (code: number, detail?: unknown) =>
    Object.assign(new Error(`Request failed with status code ${code}`), {
      response: { status: code, data: { detail } },
    });

  it("explains the hourly limit and a lapsed session in words of its own", () => {
    expect(lookUpErrorText(status(429, "Rate limit exceeded"))).toBe(
      "You've looked up a lot of spots this hour. Try again later.",
    );
    expect(lookUpErrorText(status(401, "Not authenticated"))).toBe(
      "Your session has ended. Sign in again to see the seafloor.",
    );
  });

  it("gives the API's reason for anything else, or the request's when it sent none", () => {
    expect(lookUpErrorText(status(500, "Internal Server Error"))).toBe(
      "No source gave seafloor data here (Internal Server Error). Try again in a moment.",
    );
    expect(lookUpErrorText(new Error("Network Error"))).toBe(
      "No source gave seafloor data here (Network Error). Try again in a moment.",
    );
  });
});
