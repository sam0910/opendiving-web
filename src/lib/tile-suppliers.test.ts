import { describe, expect, it } from "vitest";
import { parseSupplierList, TILE_SUPPLIER_IDS } from "@/lib/tile-suppliers";

describe("parseSupplierList", () => {
  it("keeps the operator's order, so the first named is the default", () => {
    expect(parseSupplierList("google-satellite, openfreemap")).toEqual([
      "google-satellite",
      "openfreemap",
    ]);
  });

  it("drops unknown ids and repeats, whatever the case", () => {
    expect(
      parseSupplierList("Mapbox-Streets,bing,mapbox-streets,openfreemap"),
    ).toEqual(["mapbox-streets", "openfreemap"]);
  });

  it("offers everything, the app's own basemap first, when unset or empty", () => {
    expect(parseSupplierList(undefined)).toEqual([...TILE_SUPPLIER_IDS]);
    expect(parseSupplierList(" , ")).toEqual([...TILE_SUPPLIER_IDS]);
    expect(parseSupplierList(undefined)[0]).toBe("openfreemap");
  });
});
