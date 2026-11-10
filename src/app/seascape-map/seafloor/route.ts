import { NextResponse, type NextRequest } from "next/server";

import { SEAFLOOR_MAX_SPAN_METERS, SEAFLOOR_SPANS } from "@/lib/seafloor";
import { resolveSeafloor } from "@/lib/seafloor.server";

const SPANS = new Set(SEAFLOOR_SPANS);

/**
 * `GET /seascape-map/seafloor?lat=&lon=&span=`: the best seafloor grid around a point,
 * and which sources were tried. 502 when no source could be reached.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  const span = Number(params.get("span") ?? SEAFLOOR_MAX_SPAN_METERS);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 85 ||
    Math.abs(lon) > 180 ||
    !SPANS.has(span)
  ) {
    return NextResponse.json(
      {
        error: `lat (±85), lon (±180) and span (${SEAFLOOR_SPANS.join(" or ")}) are required`,
      },
      { status: 400 },
    );
  }

  // Rounded to about 10 m, so a second look at the same spot is a cache hit.
  const round = (value: number) => Math.round(value * 1e4) / 1e4;
  const result = await resolveSeafloor(round(lat), round(lon), span);
  return NextResponse.json(result, {
    status: result.status === "failed" ? 502 : 200,
  });
}
