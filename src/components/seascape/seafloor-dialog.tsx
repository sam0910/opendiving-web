"use client";

import { useEffect, useMemo, useState } from "react";

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
  seafloorAPI,
  type SeafloorAnswer,
  type SeafloorSpan,
} from "@/lib/api/seafloor";
import {
  attemptLine,
  lookUpErrorText,
  noGridText,
  SEAFLOOR_MAX_SPAN_METERS,
  SEAFLOOR_SOURCES,
  SEAFLOOR_SPANS,
  sortAttempts,
} from "@/lib/seafloor";
import { toSeascapeGrid } from "@/lib/seascape-grid";

import { SeascapeSample } from "./seascape-sample";

export interface SeafloorPoint {
  lat: number;
  lon: number;
}

function formatPoint({ lat, lon }: SeafloorPoint): string {
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? "E" : "W"}`;
}

interface Loaded {
  /** The request this answers, so a stale answer is never shown for a new spot. */
  key: string;
  result: SeafloorAnswer | null;
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
  const [span, setSpan] = useState<SeafloorSpan>(SEAFLOOR_MAX_SPAN_METERS);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = point ? `${point.lat},${point.lon},${span}` : null;

  useEffect(() => {
    if (!point || !key) return;
    const controller = new AbortController();
    seafloorAPI
      .lookUp(point.lat, point.lon, span, controller.signal)
      .then((result) => setLoaded({ key, result }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({ key, result: null, error: lookUpErrorText(error) });
      });
    return () => controller.abort();
  }, [point, span, key]);

  const current = loaded?.key === key ? loaded : null;
  const result = current?.result ?? null;
  const grid = result?.status === "ok" ? result.grid : null;
  const source =
    result?.status === "ok" ? SEAFLOOR_SOURCES[result.source] : null;
  // Kept stable across renders: the view rebuilds its scene for a new grid object.
  const sceneGrid = useMemo(() => (grid ? toSeascapeGrid(grid) : null), [grid]);
  const attempts = sortAttempts(result?.attempts ?? []);

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
              ) : sceneGrid && source ? (
                <SeascapeSample
                  key={key}
                  grid={sceneGrid}
                  sourceLabel={source.label}
                />
              ) : (
                <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  {result && result.status !== "ok"
                    ? noGridText(result.status)
                    : current.error}
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
                    {attemptLine(attempt, grid)}
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
                {grid?.land_from === "openstreetmap" && (
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
                {grid?.land_height_from === "aws_terrain" && (
                  <>
                    {" "}
                    Land heights: AWS Terrain Tiles (Mapzen/Tilezen), from SRTM
                    and other public elevation data.{" "}
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
                {grid?.land_height_from === "gmrt" && (
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
