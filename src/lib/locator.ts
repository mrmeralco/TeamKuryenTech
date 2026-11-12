/**
 * Meralco Business Center locator logic (framework-free, testable).
 * Map rendering is delegated to a MapAdapter so the directory works without Mapbox.
 */
import { BUSINESS_CENTERS, type BusinessCenter } from "../data/meralco-business-centers";

export type { BusinessCenter };

/** Shown as the GENERAL line only — never as a branch's direct number. */
export const GENERAL_HOTLINE = { display: "(02) 16211", href: "tel:+63216211" };

const normalize = (value: string) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export function areas(centers: readonly BusinessCenter[] = BUSINESS_CENTERS): string[] {
  return [...new Set(centers.map((center) => center.area))].sort((a, b) => a.localeCompare(b));
}

/** Search by branch name, city/locality, address, or province/area (accent-insensitive). */
export function filterCenters(
  query: string,
  area = "",
  centers: readonly BusinessCenter[] = BUSINESS_CENTERS,
): BusinessCenter[] {
  const terms = normalize(query).split(" ").filter(Boolean);
  return centers.filter((center) => {
    if (area && center.area !== area) return false;
    const haystack = normalize(`${center.name} ${center.locality} ${center.address} ${center.area}`);
    return terms.every((term) => haystack.includes(term));
  });
}

/** Directions use only what the official page publishes: its place link, coordinates, or the address. */
export function directionsUrl(center: BusinessCenter): string {
  if (center.coordinates) {
    return `https://www.google.com/maps/dir/?api=1&destination=${center.coordinates.lat},${center.coordinates.lng}`;
  }
  const destination = encodeURIComponent(`${center.name}, ${center.address}`);
  return center.googlePlaceId
    ? `https://www.google.com/maps/dir/?api=1&destination=${destination}&destination_place_id=${encodeURIComponent(center.googlePlaceId)}`
    : `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
}

/** tel: link built from the digits exactly as published (no assumed area code). */
export function phoneHref(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits ? `tel:${digits}` : null;
}

export interface MarkerPosition {
  lat: number;
  lng: number;
  /** "published" = coordinates printed by the source; "geocoded" = approximate, from the published address. */
  precision: "published" | "geocoded";
}

export interface MapAdapter {
  setMarkers(markers: { id: string; position: MarkerPosition; label: string }[]): void;
  focus(id: string, position: MarkerPosition): void;
}

/** Keeps list selection and map markers in sync. */
export class LocatorController {
  private positions = new Map<string, MarkerPosition>();
  selectedId: string | null = null;

  constructor(
    private readonly map: MapAdapter | null,
    private readonly onSelect: (center: BusinessCenter) => void,
    private readonly centers: readonly BusinessCenter[] = BUSINESS_CENTERS,
  ) {
    for (const center of centers) {
      if (center.coordinates) this.positions.set(center.id, { ...center.coordinates, precision: "published" });
    }
  }

  setPosition(id: string, position: MarkerPosition): void {
    if (this.positions.get(id)?.precision === "published") return; // never overwrite published coordinates
    this.positions.set(id, position);
  }

  position(id: string): MarkerPosition | null {
    return this.positions.get(id) ?? null;
  }

  renderMarkers(visible: readonly BusinessCenter[]): void {
    this.map?.setMarkers(
      visible
        .filter((center) => this.positions.has(center.id))
        .map((center) => ({ id: center.id, position: this.positions.get(center.id)!, label: center.name })),
    );
  }

  /** Called by list clicks AND marker clicks. */
  select(id: string): BusinessCenter | null {
    const center = this.centers.find((item) => item.id === id) ?? null;
    if (!center) return null;
    this.selectedId = id;
    const position = this.positions.get(id);
    if (position) this.map?.focus(id, position);
    this.onSelect(center);
    return center;
  }
}
