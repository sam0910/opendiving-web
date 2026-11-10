import { cacheLife } from "next/cache";

// Google's Map Tiles API, for the seascape explorer's 2D map only. Its terms allow
// showing the tiles in a third-party renderer such as MapLibre, with Google's logo and
// copyright line on the map. They forbid using them for anything but display: no
// tracing coastlines out of them, no building 3D or terrain models from them. So the
// 3D view's coastline stays OpenStreetMap's.

export const GOOGLE_TILES_ORIGIN = "https://tile.googleapis.com";

export type GoogleMapType = "roadmap" | "satellite";

export interface GoogleTiles {
  /** A `{z}/{x}/{y}` template, session and key included. */
  template: string;
  session: string;
  key: string;
}

/**
 * A tile template for one map type, or null when no key is configured.
 *
 * Every 2D tile request needs a session token, and one token serves every viewer for
 * two weeks, so a token is made once and kept for a week: creating one is free, but
 * there is no reason to make more.
 */
export async function googleTiles(
  mapType: GoogleMapType,
): Promise<GoogleTiles | null> {
  "use cache";

  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) {
    cacheLife("seconds");
    return null;
  }

  const response = await fetch(
    `${GOOGLE_TILES_ORIGIN}/v1/createSession?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 512 px images for 256 px tiles, so the map is sharp on high-density screens.
      // Still one billable request per tile.
      body: JSON.stringify({
        mapType,
        language: "en-US",
        region: "KR",
        scale: "scaleFactor2x",
        highDpi: true,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body = (await response.json()) as {
    session?: string;
    error?: { message?: string };
  };
  if (!response.ok || !body.session) {
    throw new Error(
      `Google Map Tiles: ${body.error?.message ?? `HTTP ${response.status}`}`,
    );
  }

  // Revalidated after a week, gone after ten days: always inside the token's two.
  cacheLife({ stale: 3600, revalidate: 7 * 86400, expire: 10 * 86400 });
  return {
    template: `${GOOGLE_TILES_ORIGIN}/v1/2dtiles/{z}/{x}/{y}?session=${body.session}&key=${encodeURIComponent(key)}`,
    session: body.session,
    key,
  };
}
