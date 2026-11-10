"use client";

import { useEffect, useMemo, useState } from "react";

import { SeascapeSample } from "@/components/seascape/seascape-sample";
import { Card } from "@/components/ui/card";
import { PAGE_COLUMN } from "@/components/ui/map-hero";
import { PageSpinner } from "@/components/ui/page-spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthGuard } from "@/hooks/useAuthGuard";
import { getApiErrorStatus } from "@/lib/api/error";
import { seafloorAPI, type SeafloorAnswer } from "@/lib/api/seafloor";
import {
  lookUpErrorText,
  SEAFLOOR_MAX_SPAN_METERS,
  SEAFLOOR_SOURCES,
} from "@/lib/seafloor";
import { toSeascapeGrid } from "@/lib/seascape-grid";

// One fixed site for the sample: Beomseom, the island off Seogwipo on Jeju's south coast.
const SITE = {
  name: "Beomseom, Seogwipo (Jeju)",
  lat: 33.217549,
  lon: 126.514413,
};

type Loaded = { answer: SeafloorAnswer } | { error: unknown };

// Fetched in the browser rather than on the server: `GET /seafloor` is for signed-in
// accounts, and the access token lives only in this tab's memory.
export function SeascapeSamplePageContent() {
  const { user, isAuthenticated, isLoading } = useAuthGuard();
  const signedIn = isAuthenticated && !!user;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    seafloorAPI
      .lookUp(SITE.lat, SITE.lon, SEAFLOOR_MAX_SPAN_METERS, controller.signal)
      .then((answer) => setLoaded({ answer }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("Seascape sample: could not load the seafloor", error);
        setLoaded({ error });
      });
    return () => controller.abort();
  }, [signedIn]);

  const answer = loaded && "answer" in loaded ? loaded.answer : null;
  const grid = answer?.status === "ok" ? answer.grid : null;
  const source =
    answer?.status === "ok" ? SEAFLOOR_SOURCES[answer.source] : null;
  const sceneGrid = useMemo(() => (grid ? toSeascapeGrid(grid) : null), [grid]);
  // The hourly limit and a lapsed session say so; anything else is one sentence.
  const error = loaded && "error" in loaded ? loaded.error : null;
  const errorStatus = getApiErrorStatus(error);
  const failure =
    errorStatus === 429 || errorStatus === 401
      ? lookUpErrorText(error)
      : "Couldn't load seafloor data for this site. Try again in a moment.";

  if (isLoading) {
    return <PageSpinner variant="inset" />;
  }

  if (!signedIn) {
    return null; // Will redirect to signin
  }

  return (
    <div className={PAGE_COLUMN}>
      <h1 className="text-2xl font-semibold">{SITE.name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {SITE.lat.toFixed(6)}° N, {SITE.lon.toFixed(6)}° E · the seafloor 1 km
        around the site
      </p>

      <Card
        className="relative mt-6 aspect-video min-h-[420px] w-full overflow-hidden"
        aria-busy={!loaded}
      >
        {!loaded ? (
          <Skeleton className="absolute inset-0 rounded-[inherit]" />
        ) : sceneGrid && source ? (
          <SeascapeSample grid={sceneGrid} sourceLabel={source.label} />
        ) : (
          <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {failure}
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
