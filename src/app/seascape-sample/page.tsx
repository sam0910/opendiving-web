import type { Metadata } from "next";

import { SeascapeSamplePageContent } from "@/components/seascape/seascape-sample-page-content";

export const metadata: Metadata = {
  title: "Seascape sample",
  description:
    "A 3D view of the seafloor around one dive site, drawn from the best bathymetry available there.",
};

export default function SeascapeSamplePage() {
  return <SeascapeSamplePageContent />;
}
