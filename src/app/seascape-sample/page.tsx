import type { Metadata } from "next";

import { SeascapeSample } from "@/components/seascape/seascape-sample";
import { Card } from "@/components/ui/card";
import { PAGE_COLUMN } from "@/components/ui/map-hero";
import {
  SEAFLOOR_MAX_SPAN_METERS,
  SEAFLOOR_SOURCES,
  type SeafloorResult,
} from "@/lib/seafloor";
import { resolveSeafloor } from "@/lib/seafloor.server";

export const metadata: Metadata = {
  title: "Seascape sample",
  description:
    "A 3D view of the seafloor around one dive site, drawn from the best bathymetry available there.",
};

// One fixed site for the sample: Beomseom, the island off Seogwipo on Jeju's south coast.
const SITE = {
  name: "Beomseom, Seogwipo (Jeju)",
  lat: 33.217549,
  lon: 126.514413,
};

export default async function SeascapeSamplePage() {
  let result: SeafloorResult | null = null;
  try {
    result = await resolveSeafloor(
      SITE.lat,
      SITE.lon,
      SEAFLOOR_MAX_SPAN_METERS,
    );
  } catch (error) {
    console.warn("Seascape sample: could not resolve the seafloor", error);
  }
  const source =
    result?.status === "ok" ? SEAFLOOR_SOURCES[result.source] : null;

  return (
    <div className={PAGE_COLUMN}>
      <h1 className="text-2xl font-semibold">{SITE.name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {SITE.lat.toFixed(6)}° N, {SITE.lon.toFixed(6)}° E · the seafloor 1 km
        around the site
      </p>

      <Card className="relative mt-6 aspect-video min-h-[420px] w-full overflow-hidden">
        {result?.status === "ok" && source ? (
          <SeascapeSample grid={result.grid} sourceLabel={source.label} />
        ) : (
          <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Couldn&apos;t load seafloor data for this site. Try again in a
            moment.
          </p>
        )}
      </Card>

      {source && (
        <p className="mt-3 text-xs text-muted-foreground">
          Seafloor: {source.credit}{" "}
          <a
            href={source.url}
            className="underline"
            rel="noreferrer"
            target="_blank"
          >
            {source.url.replace(/^https:\/\//, "")}
          </a>
        </p>
      )}
    </div>
  );
}
