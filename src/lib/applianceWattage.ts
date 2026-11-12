/**
 * Typical power draw of common household appliances, used to suggest a wattage when the
 * label can't be read. These are TYPICAL RANGES, not measurements — the label or manual
 * always wins. Values compiled from general household references, including Daft Logic's
 * "Power consumption of typical household appliances"
 * (https://www.daftlogic.com/information-appliance-power-consumption.htm), adjusted to
 * appliances common in Philippine homes.
 */

import { REFERENCE_APPLIANCES } from "./applianceReference";

export interface AppliancePreset {
  name: string;
  /** Other names people type (English/Tagalog/brand-generic). */
  aliases: string[];
  category: "cooling" | "refrigeration" | "lighting" | "entertainment" | "laundry" | "cooking" | "computing" | "other";
  minWatts: number;
  maxWatts: number;
  /** Suggested value to prefill. */
  typicalWatts: number;
  standbyWatts?: number;
  /** Typical hours of use per day in a household. */
  hoursPerDay: number;
}

export const WATTAGE_SOURCE = {
  label: "Daft Logic — power consumption of typical household appliances",
  url: "https://www.daftlogic.com/information-appliance-power-consumption.htm",
};

export const APPLIANCE_PRESETS: AppliancePreset[] = [
  // Cooling
  { name: "Air conditioner (window, 1 HP)", aliases: ["aircon", "window aircon", "ac", "aircon 1hp", "air con"], category: "cooling", minWatts: 700, maxWatts: 1000, typicalWatts: 850, standbyWatts: 1, hoursPerDay: 8 },
  { name: "Air conditioner (split inverter, 1.5 HP)", aliases: ["inverter aircon", "split aircon", "split type", "aircon inverter", "aircon 1.5hp"], category: "cooling", minWatts: 400, maxWatts: 1500, typicalWatts: 900, standbyWatts: 2, hoursPerDay: 8 },
  { name: "Electric fan (stand)", aliases: ["fan", "electric fan", "stand fan", "bentilador"], category: "cooling", minWatts: 40, maxWatts: 75, typicalWatts: 55, hoursPerDay: 10 },
  { name: "Ceiling fan", aliases: ["ceiling fan"], category: "cooling", minWatts: 50, maxWatts: 75, typicalWatts: 60, hoursPerDay: 8 },
  { name: "Air cooler", aliases: ["air cooler", "evaporative cooler"], category: "cooling", minWatts: 60, maxWatts: 200, typicalWatts: 110, hoursPerDay: 8 },
  // Refrigeration
  { name: "Refrigerator (two-door)", aliases: ["ref", "fridge", "refrigerator", "ref inverter", "two door ref"], category: "refrigeration", minWatts: 100, maxWatts: 220, typicalWatts: 150, hoursPerDay: 24 },
  { name: "Refrigerator (single-door)", aliases: ["single door ref", "mini ref", "mini fridge"], category: "refrigeration", minWatts: 60, maxWatts: 120, typicalWatts: 85, hoursPerDay: 24 },
  { name: "Chest freezer", aliases: ["freezer", "chest freezer"], category: "refrigeration", minWatts: 100, maxWatts: 250, typicalWatts: 150, hoursPerDay: 24 },
  { name: "Water dispenser (hot & cold)", aliases: ["water dispenser", "dispenser"], category: "refrigeration", minWatts: 80, maxWatts: 600, typicalWatts: 100, hoursPerDay: 24 },
  // Lighting
  { name: "LED bulb", aliases: ["led", "led bulb", "ilaw", "light bulb", "bulb"], category: "lighting", minWatts: 5, maxWatts: 15, typicalWatts: 9, hoursPerDay: 6 },
  { name: "Fluorescent tube", aliases: ["fluorescent", "flourescent", "tube light"], category: "lighting", minWatts: 18, maxWatts: 40, typicalWatts: 36, hoursPerDay: 6 },
  { name: "Incandescent bulb", aliases: ["incandescent", "100w bulb"], category: "lighting", minWatts: 40, maxWatts: 100, typicalWatts: 60, hoursPerDay: 6 },
  // Entertainment
  { name: "LED TV (32 inch)", aliases: ["tv", "television", "smart tv", "led tv", "tv 32"], category: "entertainment", minWatts: 30, maxWatts: 60, typicalWatts: 45, standbyWatts: 0.5, hoursPerDay: 5 },
  { name: "LED TV (43–50 inch)", aliases: ["tv 43", "tv 50", "big tv", "4k tv"], category: "entertainment", minWatts: 60, maxWatts: 120, typicalWatts: 90, standbyWatts: 0.5, hoursPerDay: 5 },
  { name: "LED TV (55–65 inch)", aliases: ["tv 55", "tv 65"], category: "entertainment", minWatts: 100, maxWatts: 200, typicalWatts: 140, standbyWatts: 0.5, hoursPerDay: 5 },
  { name: "Game console", aliases: ["playstation", "xbox", "console", "nintendo switch"], category: "entertainment", minWatts: 15, maxWatts: 200, typicalWatts: 150, standbyWatts: 1, hoursPerDay: 2 },
  { name: "Sound system / speaker", aliases: ["speaker", "sound system", "karaoke", "videoke", "amplifier"], category: "entertainment", minWatts: 20, maxWatts: 300, typicalWatts: 100, standbyWatts: 1, hoursPerDay: 2 },
  { name: "Wi-Fi router", aliases: ["router", "wifi", "modem", "wi-fi"], category: "computing", minWatts: 5, maxWatts: 20, typicalWatts: 10, hoursPerDay: 24 },
  // Computing
  { name: "Laptop", aliases: ["laptop", "notebook"], category: "computing", minWatts: 30, maxWatts: 90, typicalWatts: 50, hoursPerDay: 6 },
  { name: "Desktop computer", aliases: ["desktop", "pc", "computer", "gaming pc"], category: "computing", minWatts: 100, maxWatts: 450, typicalWatts: 200, standbyWatts: 2, hoursPerDay: 6 },
  { name: "Computer monitor", aliases: ["monitor"], category: "computing", minWatts: 15, maxWatts: 40, typicalWatts: 25, hoursPerDay: 6 },
  { name: "Phone charger", aliases: ["charger", "phone charger", "cellphone charger"], category: "computing", minWatts: 5, maxWatts: 25, typicalWatts: 10, hoursPerDay: 3 },
  { name: "Printer (inkjet)", aliases: ["printer"], category: "computing", minWatts: 20, maxWatts: 50, typicalWatts: 30, standbyWatts: 2, hoursPerDay: 0.25 },
  // Laundry
  { name: "Washing machine (top load)", aliases: ["washing machine", "washer", "labahan"], category: "laundry", minWatts: 300, maxWatts: 500, typicalWatts: 400, standbyWatts: 1, hoursPerDay: 1 },
  { name: "Washing machine (twin tub)", aliases: ["twin tub", "two tub"], category: "laundry", minWatts: 250, maxWatts: 450, typicalWatts: 350, hoursPerDay: 1 },
  { name: "Clothes iron", aliases: ["iron", "flat iron", "plantsa"], category: "laundry", minWatts: 1000, maxWatts: 1800, typicalWatts: 1200, hoursPerDay: 0.5 },
  { name: "Clothes dryer", aliases: ["dryer", "tumble dryer"], category: "laundry", minWatts: 2000, maxWatts: 4000, typicalWatts: 2500, hoursPerDay: 1 },
  // Cooking
  { name: "Rice cooker", aliases: ["rice cooker", "kaldero"], category: "cooking", minWatts: 400, maxWatts: 900, typicalWatts: 600, hoursPerDay: 1 },
  { name: "Electric kettle", aliases: ["kettle", "electric kettle", "heater"], category: "cooking", minWatts: 1200, maxWatts: 3000, typicalWatts: 1500, hoursPerDay: 0.25 },
  { name: "Microwave oven", aliases: ["microwave"], category: "cooking", minWatts: 600, maxWatts: 1700, typicalWatts: 1000, standbyWatts: 3, hoursPerDay: 0.25 },
  { name: "Air fryer", aliases: ["air fryer", "airfryer"], category: "cooking", minWatts: 1200, maxWatts: 1800, typicalWatts: 1500, hoursPerDay: 0.5 },
  { name: "Induction cooker", aliases: ["induction", "induction cooker", "induction stove"], category: "cooking", minWatts: 1200, maxWatts: 2200, typicalWatts: 1800, hoursPerDay: 1 },
  { name: "Electric stove (single burner)", aliases: ["electric stove", "hot plate", "kalan"], category: "cooking", minWatts: 1000, maxWatts: 2000, typicalWatts: 1500, hoursPerDay: 1 },
  { name: "Oven toaster", aliases: ["oven toaster", "toaster"], category: "cooking", minWatts: 800, maxWatts: 1500, typicalWatts: 1000, hoursPerDay: 0.25 },
  { name: "Electric oven", aliases: ["oven", "turbo broiler"], category: "cooking", minWatts: 1500, maxWatts: 2500, typicalWatts: 2000, hoursPerDay: 0.5 },
  { name: "Blender", aliases: ["blender"], category: "cooking", minWatts: 300, maxWatts: 1000, typicalWatts: 400, hoursPerDay: 0.1 },
  { name: "Coffee maker", aliases: ["coffee maker", "coffee machine"], category: "cooking", minWatts: 800, maxWatts: 1400, typicalWatts: 1000, hoursPerDay: 0.25 },
  // Other
  { name: "Water heater (shower)", aliases: ["water heater", "shower heater"], category: "other", minWatts: 3500, maxWatts: 6000, typicalWatts: 3500, hoursPerDay: 0.5 },
  { name: "Hair dryer", aliases: ["hair dryer", "blower"], category: "other", minWatts: 1000, maxWatts: 2200, typicalWatts: 1500, hoursPerDay: 0.2 },
  { name: "Vacuum cleaner", aliases: ["vacuum"], category: "other", minWatts: 600, maxWatts: 1600, typicalWatts: 1000, hoursPerDay: 0.25 },
  { name: "Water pump", aliases: ["water pump", "jetmatic pump", "pump"], category: "other", minWatts: 250, maxWatts: 1100, typicalWatts: 750, hoursPerDay: 1 },
  { name: "Aquarium pump & filter", aliases: ["aquarium", "fish tank"], category: "other", minWatts: 5, maxWatts: 50, typicalWatts: 20, hoursPerDay: 24 },
  { name: "CCTV system", aliases: ["cctv", "dvr"], category: "other", minWatts: 15, maxWatts: 60, typicalWatts: 30, hoursPerDay: 24 },
];

const normalize = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

/** Philippine household presets first, then the full Daft Logic reference list (174 appliances). */
export const ALL_APPLIANCES: AppliancePreset[] = [...APPLIANCE_PRESETS, ...REFERENCE_APPLIANCES];

/** Best preset for something a person typed (or OCR found), or null. */
export function findAppliancePreset(query: string | null | undefined): AppliancePreset | null {
  const q = normalize(query ?? "");
  if (q.length < 2) return null;
  let best: { preset: AppliancePreset; score: number } | null = null;
  for (let index = 0; index < ALL_APPLIANCES.length; index++) {
    const preset = ALL_APPLIANCES[index];
    // On equal matches the curated Philippine presets win over the reference list.
    const local = index < APPLIANCE_PRESETS.length ? 0.5 : 0;
    for (const candidate of [preset.name, ...preset.aliases]) {
      const c = normalize(candidate);
      if (!c) continue;
      let score = 0;
      if (q === c) score = 100;
      else if (q.startsWith(c) || c.startsWith(q)) score = 70 + Math.min(c.length, q.length);
      else if (new RegExp(`\\b${c.replace(/ /g, "\\s")}\\b`).test(q)) score = 50 + c.length;
      if (score && (!best || score + local > best.score)) best = { preset, score: score + local };
    }
  }
  return best?.preset ?? null;
}
