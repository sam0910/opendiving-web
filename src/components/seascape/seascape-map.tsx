"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Minus, Plus } from "lucide-react";
import {
  Marker,
  type Map as MapLibreMap,
  type MapMouseEvent,
} from "maplibre-gl";

import { MapCanvas } from "@/components/map/map-canvas";
import { MapCredit } from "@/components/map/map-credit";
import { markerClassName } from "@/components/map/marker";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { IconTooltip } from "@/components/ui/tooltip";
import { useConfig } from "@/contexts/ConfigContext";
import { MAX_ZOOM, MIN_ZOOM, type Basemap } from "@/lib/basemap";
import type { TileSupplier } from "@/lib/tile-suppliers";
import { cn } from "@/lib/utils";

import { SeafloorDialog, type SeafloorPoint } from "./seafloor-dialog";

// Opens over Jeju's south coast, where the seascape sample sits, unless the address
// says otherwise: `?at=lat,lon,zoom`, handy for trying the other sources.
const START = { center: [126.5144, 33.2175] as [number, number], zoom: 9 };

function startView(): typeof START {
  const [lat, lon, zoom] = (
    new URLSearchParams(window.location.search).get("at") ?? ""
  )
    .split(",")
    .map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return START;
  return {
    center: [lon, lat],
    zoom: Number.isFinite(zoom) ? zoom : START.zoom,
  };
}

/** A map to pick a spot on: a double click opens that spot's seafloor in 3D. */
export default function SeascapeMap() {
  const { resolvedTheme } = useTheme();
  const { basemap } = useConfig();
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [point, setPoint] = useState<SeafloorPoint | null>(null);
  const marker = useRef<Marker | null>(null);
  // The operator's supplier (`SEASCAPE_MAP_SUPPLIERS`). The map waits for it rather
  // than drawing the app's basemap first: a second set of tiles moments later would
  // spend a metered supplier's quota for nothing.
  const [supplier, setSupplier] = useState<TileSupplier | null>(null);
  const [failed, setFailed] = useState(false);
  const [copyright, setCopyright] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/seascape-map/tile-suppliers")
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return ((await response.json()) as { supplier: TileSupplier }).supplier;
      })
      .then((found) => {
        if (!cancelled) setSupplier(found);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeBasemap = useMemo<Basemap>(
    () =>
      supplier?.template
        ? {
            mode: "raster",
            vendored: false,
            light: supplier.template,
            dark: supplier.template,
            attribution: "",
          }
        : basemap,
    [supplier, basemap],
  );

  // Google's copyright line depends on what is in view, so it is asked again
  // whenever the map stops moving.
  const google = supplier?.google;
  useEffect(() => {
    if (!map || !google) return;
    let cancelled = false;
    const refresh = () => {
      const bounds = map.getBounds();
      const query = new URLSearchParams({
        session: google.session,
        key: google.key,
        zoom: String(Math.round(map.getZoom())),
        north: String(bounds.getNorth()),
        south: String(bounds.getSouth()),
        east: String(bounds.getEast()),
        west: String(bounds.getWest()),
      });
      fetch(`https://tile.googleapis.com/tile/v1/viewport?${query}`)
        .then((response) => response.json() as Promise<{ copyright?: string }>)
        .then((body) => {
          if (!cancelled) setCopyright(body.copyright ?? "");
        })
        .catch(() => {});
    };
    refresh();
    map.on("moveend", refresh);
    return () => {
      cancelled = true;
      map.off("moveend", refresh);
    };
  }, [map, google]);

  useEffect(() => {
    if (!map) return;
    map.jumpTo(startView());
    const pick = (event: MapMouseEvent) => {
      // Wrapped, since a map panned across the antimeridian reports 190° and on.
      const { lng, lat } = event.lngLat.wrap();
      setPoint({ lat, lon: lng });
      if (!marker.current) {
        const element = document.createElement("div");
        element.className = markerClassName("pin");
        marker.current = new Marker({ element });
      }
      marker.current.setLngLat([lng, lat]).addTo(map);
    };
    map.on("dblclick", pick);
    return () => {
      map.off("dblclick", pick);
      marker.current?.remove();
      marker.current = null;
    };
  }, [map]);

  if (failed) {
    return (
      <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Couldn&apos;t load the map. The web server&apos;s log says why.
      </p>
    );
  }
  if (!supplier) {
    return <Skeleton className="absolute inset-0 rounded-[inherit]" />;
  }

  return (
    <>
      <MapCanvas
        basemap={activeBasemap}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        interactive
        cooperative={false}
        onMap={setMap}
        unsupported={
          <p className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
            This browser cannot display the map.
          </p>
        }
      />
      <div className="absolute left-2 top-2 z-10 flex flex-col gap-1">
        <IconTooltip label="Zoom in" side="right">
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="h-8 w-8"
            disabled={!map}
            onClick={() =>
              map?.easeTo({ zoom: Math.min(map.getZoom() + 1, MAX_ZOOM) })
            }
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </Button>
        </IconTooltip>
        <IconTooltip label="Zoom out" side="right">
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="h-8 w-8"
            disabled={!map}
            onClick={() =>
              map?.easeTo({ zoom: Math.max(map.getZoom() - 1, MIN_ZOOM) })
            }
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </Button>
        </IconTooltip>
      </div>
      <p className="pointer-events-none absolute bottom-7 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-background/85 px-3 py-1 text-sm shadow-sm">
        Double-click the sea to see its seafloor in 3D
      </p>
      {supplier.mark && (
        // The provider's mark, which its terms ask for on the map. Text stands in for
        // the official logo on this test page; a production page should use the logo.
        <span
          className={cn(
            "pointer-events-none absolute bottom-1.5 left-2.5 z-10 text-sm font-semibold",
            supplier.dark ? "text-white drop-shadow" : "text-neutral-700",
          )}
          aria-label={supplier.mark === "mapbox" ? "Mapbox" : "Google Maps"}
        >
          {supplier.mark}
        </span>
      )}
      {supplier.google ? (
        <MapCredit
          className="absolute bottom-0 right-0 z-10"
          value={copyright || "Google"}
        />
      ) : supplier.credit ? (
        <MapCredit
          className="absolute bottom-0 right-0 z-10"
          value={supplier.credit}
        />
      ) : (
        <MapCredit className="absolute bottom-0 right-0 z-10" />
      )}
      <SeafloorDialog point={point} onClose={() => setPoint(null)} />
    </>
  );
}
