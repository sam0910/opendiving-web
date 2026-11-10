// What the seafloor dialog says about an answer from `GET /seafloor`. The API picks
// the source, fetches and grids it, and answers in numbers and snake_case ids; every
// word the diver reads, the sources' credits among them, is written here.

import { getApiErrorMessage, getApiErrorStatus } from "@/lib/api/error";
import type {
  SeafloorAttempt,
  SeafloorGrid,
  SeafloorOutcome,
  SeafloorSourceId,
  SeafloorSpan,
} from "@/lib/api/seafloor";

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

// The sources in the order the API prefers them, for listing what was tried.
const SOURCE_ORDER: SeafloorSourceId[] = [
  "noaa_dem",
  "emodnet",
  "khoa",
  "gmrt",
  "etopo2022",
];

/**
 * The areas a view may cover, in metres a side, widest first: the two `GET /seafloor`
 * accepts. 2 km is plenty for a dive site.
 */
export const SEAFLOOR_SPANS: SeafloorSpan[] = [2000, 1000];
export const SEAFLOOR_MAX_SPAN_METERS = SEAFLOOR_SPANS[0];

const OUTCOME_TEXT: Record<SeafloorOutcome, string> = {
  used: "used",
  no_coverage: "doesn't cover this spot",
  not_configured: "not set up",
  not_needed: "not needed",
  too_coarse: "too coarse",
  too_little_data: "too little data",
  mostly_land: "mostly land",
  failed: "failed",
};

// The API setting a source needs before it can be asked. Only KHOA has one.
const SOURCE_SETTING: Partial<Record<SeafloorSourceId, string>> = {
  khoa: "KHOA_API_KEY",
};

function formatMeters(meters: number): string {
  return `~${meters < 10 ? meters.toFixed(1) : Math.round(meters)} m`;
}

function percent(fraction: number | null): number {
  return Math.round((fraction ?? 0) * 100);
}

/** Where the used source's land came from, as the source list says it. */
function landNote(grid: SeafloorGrid | null): string {
  const coast =
    grid?.land_from === "openstreetmap"
      ? " · coastline from OpenStreetMap"
      : grid?.land_from === "soundings"
        ? " · coastline from gaps between soundings"
        : "";
  const heights =
    grid?.land_height_from === "aws_terrain"
      ? " · land heights from AWS Terrain Tiles"
      : grid?.land_height_from === "gmrt"
        ? " · land heights from GMRT"
        : grid?.land_height_from === "flat"
          ? " · land drawn flat"
          : "";
  return coast + heights;
}

/** The part of a source's line after its outcome, or null when there is nothing to add. */
function attemptDetail(
  attempt: SeafloorAttempt,
  grid: SeafloorGrid | null,
): string | null {
  const size = `${attempt.cols} × ${attempt.rows} cells`;
  switch (attempt.outcome) {
    case "used":
      return `${size}, ~${Math.round(attempt.resolution_meters ?? 0)} m${landNote(grid)}`;
    case "too_coarse":
      return `${size} at this span`;
    case "too_little_data":
      return `${percent(attempt.known_fraction)}% of cells have a reading`;
    case "mostly_land":
      return `${percent(attempt.wet_fraction)}% of cells are water`;
    case "failed":
      return attempt.error;
    case "not_configured":
      return SOURCE_SETTING[attempt.source]
        ? `${SOURCE_SETTING[attempt.source]} is not set`
        : null;
    case "no_coverage":
      // A cell size means the source claimed the spot, then had nothing in it once
      // asked: KHOA on land inside its box.
      return attempt.cell_size_meters !== null
        ? `no ${SEAFLOOR_SOURCES[attempt.source].label} data in this area`
        : null;
    case "not_needed":
      return null;
  }
}

/**
 * One line of the dialog's source list, e.g. "KHOA (~144 m native): used · 125 × 126
 * cells, ~16 m · coastline from OpenStreetMap". `grid` is the answer's, which belongs
 * to the used source and says where its land came from.
 */
export function attemptLine(
  attempt: SeafloorAttempt,
  grid: SeafloorGrid | null,
): string {
  const native =
    attempt.cell_size_meters !== null
      ? ` (${formatMeters(attempt.cell_size_meters)} native)`
      : "";
  const detail = attemptDetail(attempt, grid);
  return `${SEAFLOOR_SOURCES[attempt.source].label}${native}: ${OUTCOME_TEXT[attempt.outcome]}${detail ? ` · ${detail}` : ""}`;
}

/** The attempts in the order the API prefers their sources. */
export function sortAttempts(attempts: SeafloorAttempt[]): SeafloorAttempt[] {
  return [...attempts].sort(
    (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source),
  );
}

/** What the view says when there is no grid to draw: on land, or nothing usable. */
export function noGridText(status: "dry" | "failed"): string {
  return status === "dry"
    ? "Every source puts this spot on land. Double-click somewhere in the water."
    : "No source gave seafloor data here. Try again in a moment.";
}

/**
 * What the view says when `GET /seafloor` refused or never answered: the hourly
 * per-account limit, a session that lapsed, or anything else with its reason.
 */
export function lookUpErrorText(error: unknown): string {
  const status = getApiErrorStatus(error);
  if (status === 429) {
    return "You've looked up a lot of spots this hour. Try again later.";
  }
  if (status === 401) {
    return "Your session has ended. Sign in again to see the seafloor.";
  }
  const reason = getApiErrorMessage(
    error,
    error instanceof Error ? error.message : String(error),
  );
  return `No source gave seafloor data here (${reason}). Try again in a moment.`;
}
