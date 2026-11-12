import { describe, expect, it, vi } from "vitest";
import { BUSINESS_CENTERS, BUSINESS_CENTERS_SOURCE } from "../data/meralco-business-centers";
import { areas, directionsUrl, filterCenters, LocatorController, phoneHref, type MapAdapter } from "./locator";

describe("verified Business Center data", () => {
  it("matches the official directory's published count with unique ids", () => {
    expect(BUSINESS_CENTERS).toHaveLength(BUSINESS_CENTERS_SOURCE.publishedCount);
    expect(new Set(BUSINESS_CENTERS.map((c) => c.id)).size).toBe(52);
    expect(BUSINESS_CENTERS_SOURCE.url).toBe("https://www.meralco.com.ph/help/meralco-business-centers");
    expect(areas()).toEqual(["Batangas", "Bulacan", "Cavite", "Laguna", "Metro Manila", "Quezon", "Rizal"]);
  });

  it("stores no invented hours or coordinates", () => {
    for (const center of BUSINESS_CENTERS) {
      expect(Object.keys(center)).not.toContain("hours");
      if (center.phone !== null) expect(center.phone).toMatch(/^1622 \d{4}$/);
    }
    const withCoordinates = BUSINESS_CENTERS.filter((c) => c.coordinates);
    expect(withCoordinates.map((c) => c.name)).toEqual(["Meralco Business Center - San Miguel Branch"]);
    expect(BUSINESS_CENTERS.filter((c) => c.phone === null)).toHaveLength(7);
  });
});

describe("search and links", () => {
  it("searches by branch, city, and province, accent-insensitively", () => {
    expect(filterCenters("makati").map((c) => c.id)).toEqual(["makati-branch"]);
    expect(filterCenters("dasmarinas").map((c) => c.locality)).toEqual(["Dasmariñas City, Cavite"]);
    expect(filterCenters("", "Rizal")).toHaveLength(5);
    expect(filterCenters("quezon city", "Metro Manila").length).toBeGreaterThan(3);
    expect(filterCenters("laguna santa rosa")).toHaveLength(2);
    expect(filterCenters("nowhere-xyz")).toEqual([]);
  });

  it("builds directions only from published place ids, coordinates, or addresses", () => {
    const sanMiguel = BUSINESS_CENTERS.find((c) => c.coordinates)!;
    expect(directionsUrl(sanMiguel)).toBe("https://www.google.com/maps/dir/?api=1&destination=15.145878,120.972198");
    const makati = filterCenters("makati")[0];
    expect(directionsUrl(makati)).toContain("destination_place_id=ChIJYZdBqKDJlzMRG1CYNjrN-rQ");
    expect(phoneHref("1622 6584")).toBe("tel:16226584");
    expect(phoneHref(null)).toBeNull();
  });
});

describe("map/list synchronization (Mapbox adapter contract)", () => {
  it("renders markers only for positioned centers and syncs selection both ways", () => {
    const map: MapAdapter = { setMarkers: vi.fn(), focus: vi.fn() };
    const selected: string[] = [];
    const controller = new LocatorController(map, (center) => selected.push(center.id));
    controller.renderMarkers(BUSINESS_CENTERS);
    expect(vi.mocked(map.setMarkers).mock.calls[0][0]).toHaveLength(1); // only published coordinates

    controller.setPosition("makati-branch", { lat: 14.55, lng: 121.02, precision: "geocoded" });
    controller.renderMarkers(BUSINESS_CENTERS);
    expect(vi.mocked(map.setMarkers).mock.calls[1][0].map((m) => m.id)).toContain("makati-branch");

    controller.select("makati-branch"); // e.g. marker click or list click
    expect(map.focus).toHaveBeenCalledWith("makati-branch", { lat: 14.55, lng: 121.02, precision: "geocoded" });
    expect(selected).toEqual(["makati-branch"]);

    controller.select("karuhatan-branch"); // no position: still selectable, map untouched
    expect(map.focus).toHaveBeenCalledTimes(1);
    expect(controller.selectedId).toBe("karuhatan-branch");
  });

  it("never overwrites published coordinates with geocoded ones", () => {
    const controller = new LocatorController(null, () => undefined);
    controller.setPosition("san-miguel-branch", { lat: 0, lng: 0, precision: "geocoded" });
    expect(controller.position("san-miguel-branch")).toEqual({ lat: 15.145878, lng: 120.972198, precision: "published" });
  });
});
