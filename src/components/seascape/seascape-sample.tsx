"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

// The seascape, fetched in the browser: three.js needs a WebGL2 context and a real
// element, and has no business in the bundle until the view is drawn.
export const SeascapeSample = dynamic(() => import("./seascape-view"), {
  ssr: false,
  loading: () => <Skeleton className="absolute inset-0 rounded-[inherit]" />,
});
