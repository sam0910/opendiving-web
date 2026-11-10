import { NextResponse } from "next/server";

import { tileSupplier } from "@/lib/tile-suppliers.server";

/**
 * `GET /seascape-map/tile-suppliers`: the supplier the 2D map is drawn from, picked by
 * the operator in `SEASCAPE_MAP_SUPPLIERS`. Google's and Mapbox's tile templates carry
 * their keys, as every tile request from a browser must.
 */
export async function GET() {
  try {
    return NextResponse.json({ supplier: await tileSupplier() });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "The map supplier is not set up" },
      { status: 503 },
    );
  }
}
