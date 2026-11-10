"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

// The explorer's map, fetched in the browser: MapLibre needs a WebGL2 context and a
// real element, and has no business in the bundle until the map is drawn. Busy on the
// outside while it loads, the bar itself hidden, as every page frame is.
export const SeascapeMap = dynamic(() => import("./seascape-map"), {
  ssr: false,
  loading: () => (
    <div aria-busy className="absolute inset-0 rounded-[inherit]">
      <Skeleton className="absolute inset-0 rounded-[inherit]" />
    </div>
  ),
});
