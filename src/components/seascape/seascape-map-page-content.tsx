"use client";

import { SeascapeMap } from "@/components/seascape/seascape-map-lazy";
import { Card } from "@/components/ui/card";
import { PAGE_COLUMN } from "@/components/ui/map-hero";
import { PageSpinner } from "@/components/ui/page-spinner";
import { useAuthGuard } from "@/hooks/useAuthGuard";

// Signed in only: the seafloor comes from `GET /seafloor`, which answers accounts.
export function SeascapeMapPageContent() {
  const { user, isAuthenticated, isLoading } = useAuthGuard();

  if (isLoading) {
    return <PageSpinner variant="inset" />;
  }

  if (!isAuthenticated || !user) {
    return null; // Will redirect to signin
  }

  return (
    <div className={PAGE_COLUMN}>
      <h1 className="text-2xl font-semibold">Seafloor explorer</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Double-click anywhere in the water. The view uses the finest depth data
        that covers the spot: KHOA&apos;s survey data in Korean waters,
        NOAA&apos;s coastal models around the US, EMODnet in European seas, GMRT
        anywhere else, and ETOPO 2022 as the last resort.
      </p>

      <Card className="relative mt-6 h-[65vh] min-h-[420px] w-full overflow-hidden">
        <SeascapeMap />
      </Card>
    </div>
  );
}
