import { describe, expect, it } from "vitest";
import { ALL_APPLIANCES, APPLIANCE_PRESETS, findAppliancePreset } from "./applianceWattage";

describe("appliance wattage presets", () => {
  it("has sane ranges", () => {
    for (const p of APPLIANCE_PRESETS) {
      expect(p.minWatts).toBeGreaterThan(0);
      expect(p.maxWatts).toBeGreaterThanOrEqual(p.minWatts);
      expect(p.typicalWatts).toBeGreaterThanOrEqual(p.minWatts);
      expect(p.typicalWatts).toBeLessThanOrEqual(p.maxWatts);
      expect(p.hoursPerDay).toBeGreaterThan(0);
      expect(p.hoursPerDay).toBeLessThanOrEqual(24);
    }
  });

  it("matches common names, aliases and Tagalog words", () => {
    expect(findAppliancePreset("Rice cooker")?.category).toBe("cooking");
    expect(findAppliancePreset("ref")?.category).toBe("refrigeration");
    expect(findAppliancePreset("Bedroom aircon")?.category).toBe("cooling");
    expect(findAppliancePreset("plantsa")?.name).toBe("Clothes iron");
    expect(findAppliancePreset("bentilador")?.name).toBe("Electric fan (stand)");
  });

  it("includes the Daft Logic reference list with sane ranges", () => {
    expect(ALL_APPLIANCES.length).toBeGreaterThan(200);
    for (const p of ALL_APPLIANCES) {
      expect(p.maxWatts).toBeGreaterThanOrEqual(p.minWatts);
      expect(p.typicalWatts).toBeGreaterThanOrEqual(p.minWatts);
      expect(p.typicalWatts).toBeLessThanOrEqual(p.maxWatts);
    }
    expect(findAppliancePreset("Playstation 5")).toMatchObject({ minWatts: 160, maxWatts: 200 });
    expect(findAppliancePreset("PS4")?.name).toBe("Playstation 4");
    expect(findAppliancePreset("Hair Dryer")?.category).toBe("other");
    // Curated Philippine presets win over the reference list for the same word.
    expect(findAppliancePreset("rice cooker")?.name).toBe("Rice cooker");
  });

  it("returns null for unknown or too-short input", () => {
    expect(findAppliancePreset("x")).toBeNull();
    expect(findAppliancePreset("spaceship")).toBeNull();
  });
});
