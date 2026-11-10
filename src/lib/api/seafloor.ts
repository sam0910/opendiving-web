import { apiClient } from "./client";
import { getApiErrorStatus } from "./error";

/** The bathymetry services the API picks between, in the order it prefers them. */
export type SeafloorSourceId =
  "noaa_dem" | "emodnet" | "khoa" | "gmrt" | "etopo2022";

/** The sides `GET /seafloor` accepts for its square, in metres; anything else is a 422. */
export type SeafloorSpan = 2000 | 1000;

/**
 * A depth grid around the point, as `GET /seafloor` sends it.
 *
 * Depths are metres, **positive below sea level** and negative on land above it,
 * `null` where a cell has no reading; row-major, the southernmost row first and
 * each row west to east. At most 160 cells a side.
 */
export interface SeafloorGrid {
  /** Centre of the south-west cell, in degrees. */
  origin_lat: number;
  origin_lon: number;
  /** Degrees between rows, and between columns. */
  cell_lat: number;
  cell_lon: number;
  rows: number;
  cols: number;
  depths: (number | null)[];
  /** Roughly how far apart neighbouring cells are, in metres. */
  resolution_meters: number;
  /** The point the API answered for, rounded to four decimals (about 10 m). */
  center_lat: number;
  center_lon: number;
  /**
   * Where the coastline came from, for a source with no land of its own (KHOA):
   * map data, or the gaps between its soundings. Null for one that measures land.
   */
  land_from: "openstreetmap" | "soundings" | null;
  /** Where that source's land heights came from; null for every other source. */
  land_height_from: "aws_terrain" | "gmrt" | "flat" | null;
}

/** What happened when one source was considered for the point. */
export type SeafloorOutcome =
  | "used"
  | "no_coverage"
  | "not_configured"
  | "not_needed"
  | "too_coarse"
  | "too_little_data"
  | "mostly_land"
  | "failed";

/**
 * One source's part in an answer. Numbers only: the dialog writes the prose.
 *
 * `cols`, `rows` and `resolution_meters` describe the grid the source gave
 * *before* the API averaged it down to 160 a side, and are set on `used`,
 * `too_coarse`, `too_little_data` and `mostly_land`.
 */
export interface SeafloorAttempt {
  source: SeafloorSourceId;
  outcome: SeafloorOutcome;
  /** The cell size the source claims at the point, in metres, when it said. */
  cell_size_meters: number | null;
  cols: number | null;
  rows: number | null;
  resolution_meters: number | null;
  /** Share of cells with a reading, 0..1; set on used, too_little_data and mostly_land. */
  known_fraction: number | null;
  /** Share of those readings under water, 0..1; set on used and mostly_land. */
  wet_fraction: number | null;
  /** Why a `failed` source failed, e.g. "HTTP 502" or "timed out". */
  error: string | null;
}

/**
 * The API's answer for a point: a grid from one source, "on land" (`dry`), or
 * `failed` when no source could be reached or none gave a usable grid. Every one
 * of them carries what each source said.
 */
export type SeafloorAnswer =
  | {
      status: "ok";
      source: SeafloorSourceId;
      grid: SeafloorGrid;
      attempts: SeafloorAttempt[];
    }
  | { status: "dry"; source: null; grid: null; attempts: SeafloorAttempt[] }
  | {
      status: "failed";
      source: null;
      grid: null;
      attempts: SeafloorAttempt[];
    };

/** The seafloor explorer's depth data, which the API fetches from public bathymetry services. */
export const seafloorAPI = {
  /**
   * The best depth grid for a square `span` metres across around a point, and
   * what every source said about it.
   *
   * A `failed` answer is a 503 whose body is still the whole answer, attempts and
   * all, so it is returned here rather than thrown: the attempts are what tell
   * the diver why there is nothing to draw. Everything else that is not a 200
   * throws, the per-account 429 and a lapsed session's 401 among them.
   */
  async lookUp(
    lat: number,
    lon: number,
    span: SeafloorSpan,
    signal?: AbortSignal,
  ): Promise<SeafloorAnswer> {
    try {
      const response = await apiClient.get<SeafloorAnswer>(`/seafloor`, {
        params: { lat, lon, span },
        signal,
      });
      return response.data;
    } catch (error) {
      const body = (error as { response?: { data?: Partial<SeafloorAnswer> } })
        ?.response?.data;
      if (
        getApiErrorStatus(error) === 503 &&
        body?.status === "failed" &&
        Array.isArray(body.attempts)
      ) {
        return body as SeafloorAnswer;
      }
      throw error;
    }
  },
};
