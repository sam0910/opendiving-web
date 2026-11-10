import { NextResponse } from "next/server";

import { tileSuppliers } from "@/lib/tile-suppliers.server";

/**
 * `GET /seascape-map/tile-suppliers`: the 2D map suppliers this instance offers, the
 * default first. Google's and Mapbox's tile templates carry their keys, as every tile
 * request from a browser must.
 */
export async function GET() {
  return NextResponse.json({ suppliers: await tileSuppliers() });
}
