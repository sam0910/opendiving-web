import type { Metadata } from "next";

import { SeascapeMapPageContent } from "@/components/seascape/seascape-map-page-content";

export const metadata: Metadata = {
  title: "Seafloor explorer",
  description:
    "Double-click anywhere in the water to see its seafloor in 3D, from the best bathymetry available there.",
};

export default function SeascapeMapPage() {
  return <SeascapeMapPageContent />;
}
