"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SEAFLOOR_MAX_SPAN_METERS,
  SEAFLOOR_SOURCES,
  SEAFLOOR_SPANS,
  type SeafloorAttempt,
  type SeafloorResult,
  type SeafloorSourceId,
} from "@/lib/seafloor";

import { SeascapeSample } from "./seascape-sample";

export interface SeafloorPoint {
  lat: number;
  lon: number;
}

// The sources in the order they are preferred, for listing what was tried.
const SOURCE_ORDER: SeafloorSourceId[] = [
  "noaa_dem",
  "emodnet",
  "khoa",
  "gmrt",
  "etopo2022",
];

const OUTCOME_TEXT: Record<SeafloorAttempt["outcome"], string> = {
  used: "used",
  "no coverage": "doesn't cover this spot",
  "not configured": "not set up",
  "not needed": "not needed",
  "too coarse": "too coarse",
  "too little data": "too little data",
  "mostly land": "mostly land",
  failed: "failed",
};

function formatPoint({ lat, lon }: SeafloorPoint): string {
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? "E" : "W"}`;
}

function formatMeters(meters: number): string {
  return `~${meters < 10 ? meters.toFixed(1) : Math.round(meters)} m`;
}

interface Loaded {
  /** The request this answers, so a stale answer is never shown for a new spot. */
  key: string;
  result: SeafloorResult | null;
  error?: string;
}

/** The seafloor around a picked spot, from the best source there, in a dialog. */
export function SeafloorDialog({
  point,
  onClose,
}: {
  point: SeafloorPoint | null;
  onClose: () => void;
}) {
  const [span, setSpan] = useState(SEAFLOOR_MAX_SPAN_METERS);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = point ? `${point.lat},${point.lon},${span}` : null;

  useEffect(() => {
    if (!point || !key) return;
    const controller = new AbortController();
    const query = new URLSearchParams({
      lat: String(point.lat),
      lon: String(point.lon),
      span: String(span),
    });
    fetch(`/seascape-map/seafloor?${query}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as SeafloorResult & {
          error?: string;
        };
        // A 502 still carries what each source said; only a refusal has nothing.
        if (!response.ok && !body.attempts) {
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        setLoaded({ key, result: body });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({
          key,
          result: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, [point, span, key]);

  const current = loaded?.key === key ? loaded : null;
  const result = current?.result ?? null;
  const source =
    result?.status === "ok" ? SEAFLOOR_SOURCES[result.source] : null;
  const attempts = [...(result?.attempts ?? [])].sort(
    (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source),
  );

  return (
    <Dialog
      open={point !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      dismissOnOutsidePress
    >
      <DialogContent className="max-w-5xl sm:max-w-5xl">
        {point && (
          <>
            <DialogHeader>
              <DialogTitle>Seafloor at {formatPoint(point)}</DialogTitle>
              <DialogDescription>
                The finest depth data available here, {span / 1000} km across.
                Drag to rotate, scroll to zoom.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Area</span>
              {SEAFLOOR_SPANS.map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={value === span ? "default" : "outline"}
                  aria-pressed={value === span}
                  onClick={() => setSpan(value)}
                >
                  {value / 1000} km
                </Button>
              ))}
            </div>

            {/* A fixed height rather than an aspect ratio: the dialog is a height-capped
                grid, and a clipped aspect-ratio box would shrink with it and let the list
                below ride up over the view on a short window. */}
            <div className="relative h-[clamp(320px,55vh,560px)] w-full shrink-0 overflow-hidden rounded-lg border">
              {!current ? (
                <>
                  <Skeleton className="absolute inset-0" />
                  <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                    Finding the best seafloor data…
                  </p>
                </>
              ) : result?.status === "ok" && source ? (
                <SeascapeSample
                  key={key}
                  grid={result.grid}
                  sourceLabel={source.label}
                />
              ) : (
                <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  {result?.status === "dry"
                    ? "Every source puts this spot on land. Double-click somewhere in the water."
                    : `No source gave seafloor data here${current.error ? ` (${current.error})` : ""}. Try again in a moment.`}
                </p>
              )}
            </div>

            {attempts.length > 0 && (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {attempts.map((attempt) => (
                  <li
                    key={attempt.source}
                    className={
                      attempt.outcome === "used"
                        ? "font-medium text-foreground"
                        : undefined
                    }
                  >
                    {SEAFLOOR_SOURCES[attempt.source].label}
                    {attempt.cellSizeMeters !== undefined &&
                      ` (${formatMeters(attempt.cellSizeMeters)} native)`}
                    : {OUTCOME_TEXT[attempt.outcome]}
                    {attempt.detail && ` · ${attempt.detail}`}
                  </li>
                ))}
              </ul>
            )}

            {source && (
              <p className="text-xs text-muted-foreground">
                Seafloor: {source.credit}{" "}
                <a
                  href={source.url}
                  className="underline"
                  rel="noreferrer"
                  target="_blank"
                >
                  {source.url.replace(/^https:\/\//, "")}
                </a>
                {result?.status === "ok" &&
                  result.grid.landFrom === "openstreetmap" && (
                    <>
                      {" "}
                      Coastline:{" "}
                      <a
                        href="https://www.openstreetmap.org/copyright"
                        className="underline"
                        rel="noreferrer"
                        target="_blank"
                      >
                        © OpenStreetMap contributors
                      </a>
                      , via OpenFreeMap.
                    </>
                  )}
                {result?.status === "ok" &&
                  result.grid.landHeightFrom === "aws-terrain" && (
                    <>
                      {" "}
                      Land heights: AWS Terrain Tiles (Mapzen/Tilezen), from
                      SRTM and other public elevation data.{" "}
                      <a
                        href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md"
                        className="underline"
                        rel="noreferrer"
                        target="_blank"
                      >
                        Sources
                      </a>
                    </>
                  )}
                {result?.status === "ok" &&
                  result.grid.landHeightFrom === "gmrt" && (
                    <>
                      {" "}
                      Land heights: {SEAFLOOR_SOURCES.gmrt.credit}{" "}
                      <a
                        href={SEAFLOOR_SOURCES.gmrt.url}
                        className="underline"
                        rel="noreferrer"
                        target="_blank"
                      >
                        {SEAFLOOR_SOURCES.gmrt.url.replace(/^https:\/\//, "")}
                      </a>
                    </>
                  )}
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
