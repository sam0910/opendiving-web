import { describe, expect, it } from "vitest";
import { parseSupplier } from "@/lib/tile-suppliers";

describe("parseSupplier", () => {
  it("takes the one supplier named, whatever the case or spacing", () => {
    expect(parseSupplier(" Google-Satellite ")).toBe("google-satellite");
  });

  it("uses the app's own basemap when unset or empty", () => {
    expect(parseSupplier(undefined)).toBe("openfreemap");
    expect(parseSupplier("  ")).toBe("openfreemap");
  });

  it("refuses an unknown id or a list rather than guessing", () => {
    expect(() => parseSupplier("bing")).toThrow(/SEASCAPE_MAP_SUPPLIERS/);
    expect(() => parseSupplier("google-satellite,openfreemap")).toThrow(
      /SEASCAPE_MAP_SUPPLIERS/,
    );
  });
});
