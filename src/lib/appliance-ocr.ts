/**
 * Appliance specification extraction and deterministic electrical validation.
 *
 * Implements Google Lens-style label parsing from OCR text (Tesseract.js or Gemini Vision).
 * Normalizes electrical units without altering their physical meaning:
 * - 65W -> 65 W
 * - 0.5kW -> 500 W
 * - 220V -> voltage (never power)
 * - 60Hz -> frequency (never power)
 * - 1.2A -> current (not real power)
 * - 24 kWh/month -> tested monthly consumption (not power)
 * - 9,000 BTU/h / 1.0 HP -> cooling/motor capacity (not electrical input wattage)
 *
 * Supports label classification:
 * - ELECTRICAL_SPECIFICATION: rating plates with rated watts/kW, V, A, Hz
 * - ENERGY_EFFICIENCY: yellow/orange energy guide labels (tested kWh, EER/star rating, no rated W)
 * - MIXED: labels containing both rated input power and energy guide/efficiency metrics
 * - UNKNOWN: unclassifiable or unreadable label
 */

export type LabelType = "ELECTRICAL_SPECIFICATION" | "ENERGY_EFFICIENCY" | "MIXED" | "UNKNOWN";
export type ConsumptionBasis = "wattage" | "monthly_test" | "daily_test" | "annual_test" | "none";

export interface WattageCandidate {
  value: number;
  label: string;
  context: string;
}

export interface ApplianceOcrResult {
  rawText: string;
  labelType: LabelType;
  consumptionBasis: ConsumptionBasis;
  brand: string | null;
  model: string | null;
  name: string;
  category: string;
  watts: number | null;
  wattageCandidates: WattageCandidate[];
  voltage: string | null;
  frequency: string | null;
  currentAmps: number | null;
  testedKwhMonth: number | null;
  testedKwh24h: number | null;
  testedKwhYear: number | null;
  energyEfficiencyRating: number | null;
  coolingBtuHr: number | null;
  motorHp: number | null;
  isDerivedPower: boolean;
  derivedPowerExplanation: string | null;
  uncertainties: string[];
  confidence: "high" | "medium" | "low";
}

const COMMON_BRANDS = [
  "Samsung", "LG", "Panasonic", "Carrier", "Condura", "Whirlpool", "Sharp",
  "Haier", "Daikin", "Midea", "TCL", "Sony", "Kolin", "Electrolux", "Fujidenzo",
  "Philips", "Toshiba", "Hitachi", "Hanabishi", "Standard", "Asahi", "Everest",
  "Xiaomi", "Hisense", "Koppel", "Dyson", "GE", "General Electric", "Bosch",
  "Imarflex", "Kyowa", "Eureka", "Dowell", "Astron", "Sanyo", "Aqua",
];

const CATEGORY_KEYWORDS: { category: string; defaultName: string; keywords: RegExp[] }[] = [
  {
    category: "cooling",
    defaultName: "Air Conditioner",
    keywords: [
      /\b(?:air\s*con(?:ditioner)?|split\s*type|window\s*type|inverter\s*air|cooling\s*unit)\b/i,
    ],
  },
  {
    category: "cooling",
    defaultName: "Electric Fan",
    keywords: [
      /\b(?:electric\s*fan|stand\s*fan|desk\s*fan|ceiling\s*fan|tower\s*fan|exhaust\s*fan|orbit\s*fan)\b/i,
    ],
  },
  {
    category: "refrigeration",
    defaultName: "Refrigerator",
    keywords: [
      /\b(?:refrigerat(?:or|ing|ion)?|fridge|freezer|chiller|no\s*frost|frost[- ]free|inverter\s*ref(?:rigerator)?|beverage\s*cooler)\b/i,
    ],
  },
  {
    category: "laundry",
    defaultName: "Washing Machine",
    keywords: [
      /\b(?:washing\s*machine|washer(?:\s*dryer)?|twin\s*tub|spin\s*dryer|clothes\s*dryer)\b/i,
    ],
  },
  {
    category: "entertainment",
    defaultName: "Television",
    keywords: [
      /\b(?:television|smart\s*tv|led\s*tv|oled\s*tv|lcd\s*tv|soundbar|home\s*theater)\b/i,
    ],
  },
  {
    category: "cooking",
    defaultName: "Microwave Oven",
    keywords: [/\b(?:microwave(?:\s*oven)?)\b/i],
  },
  {
    category: "cooking",
    defaultName: "Rice Cooker",
    keywords: [/\b(?:rice\s*cooker|multi\s*cooker|pressure\s*cooker)\b/i],
  },
  {
    category: "cooking",
    defaultName: "Induction Cooker",
    keywords: [/\b(?:induction\s*cooker|electric\s*stove|air\s*fryer|toaster\s*oven|electric\s*kettle|blender)\b/i],
  },
  {
    category: "computing",
    defaultName: "Computer",
    keywords: [/\b(?:desktop\s*pc|computer|laptop|monitor|printer)\b/i],
  },
  {
    category: "lighting",
    defaultName: "Lighting",
    keywords: [/\b(?:led\s*bulb|floodlight|downlight|fluorescent|lamp)\b/i],
  },
];

export function cleanOcrText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[\u2122\u00AE\u00A9]/g, " ") // ™, ®, ©
    .replace(/[—–]/g, "-")
    .replace(/[“”‘’′`]/g, '"')
    .replace(/[\t ]+/g, " ");
}

/** Extract brand if explicitly present in OCR text. */
export function extractBrand(text: string): string | null {
  // Check for explicit "Brand Name:" or "Brand:" or "Make:"
  const brandPrefixMatch = text.match(/\b(?:brand(?:\s*name)?|make|trade\s*mark)[:\s]+([A-Za-z0-9&.\- ]{2,30})/i);
  if (brandPrefixMatch) {
    const candidate = brandPrefixMatch[1].trim().split(/\n|,|;/)[0].trim();
    if (candidate.length >= 2 && candidate.length <= 30) {
      // Find matching known brand if possible
      const matched = COMMON_BRANDS.find((b) => candidate.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(candidate.toLowerCase()));
      if (matched) return matched;
      if (!/^(?:name|code|model|item|no\.?)$/i.test(candidate)) {
        return candidate;
      }
    }
  }

  // Check known brands
  for (const brand of COMMON_BRANDS) {
    const pattern = new RegExp(`\\b${brand.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (pattern.test(text)) {
      return brand;
    }
  }

  return null;
}

/** Extract appliance category and suggested name based on keywords. */
export function extractCategoryAndName(
  text: string,
  brand: string | null,
): { category: string; name: string } {
  for (const entry of CATEGORY_KEYWORDS) {
    for (const kw of entry.keywords) {
      if (kw.test(text)) {
        const baseName = brand ? `${brand} ${entry.defaultName}` : entry.defaultName;
        return { category: entry.category, name: baseName };
      }
    }
  }

  const defaultName = brand ? `${brand} Appliance` : "Appliance";
  return { category: "other", name: defaultName };
}

/** Extract model number while avoiding confusion with electrical units and description words. */
export function extractModel(text: string): string | null {
  // First, look for explicit "Product Model" or "Model" or "Model No." declarations
  const explicitModelMatch = text.match(
    /\b(?:product\s*model|model|mod)(?:\s*(?:no\.?|number|code|#))?[:\s]+([A-Z0-9][A-Z0-9\-_./]{2,25})\b/i
  );
  if (explicitModelMatch) {
    const candidate = explicitModelMatch[1].trim();
    if (!/^\d+(?:\.\d+)?\s*(?:v|w|kw|hz|a|btu|hp)$/i.test(candidate)) {
      return candidate;
    }
  }

  // Second, look for M/N or P/N
  const pnMatch = text.match(/\b(?:m\/n|p\/n)[:\s]+([A-Z0-9][A-Z0-9\-_./]{2,25})\b/i);
  if (pnMatch) {
    const candidate = pnMatch[1].trim();
    if (!/^\d+(?:\.\d+)?\s*(?:v|w|kw|hz|a|btu|hp)$/i.test(candidate)) {
      return candidate;
    }
  }

  // Third, look for "Type:" or "Cat:" only when preceded by boundary and not hyphenated (e.g. not "split-type")
  const typeMatch = text.match(/(?<![A-Za-z\-])\b(?:type|cat)(?:\s*(?:no\.?|number|code|#))?[:\s]+([A-Z0-9][A-Z0-9\-_./]{2,25})\b/i);
  if (typeMatch) {
    const candidate = typeMatch[1].trim();
    // Exclude common description words like "Air", "Split", "Inverter", "Window", "Appliance"
    if (!/^(?:air|split|window|inverter|indoor|outdoor|stand|desk|desk\s*fan|appliance)$/i.test(candidate) &&
        !/^\d+(?:\.\d+)?\s*(?:v|w|kw|hz|a|btu|hp)$/i.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Extract Voltage in V (e.g. 220V, 230 V, 220-240V). */
export function extractVoltage(text: string): { display: string; volts: number | null } | null {
  // Prefer explicit "Voltage: 220V" or "Volts: 220V"
  const explicitMatch = text.match(/(?:voltage|volts?|rated\s*voltage)[:\s]*(\d{2,3}(?:\s*[-~/]\s*\d{2,3})?)\s*(?:v|vac|volts?|~)?\b/i);
  if (explicitMatch) {
    const raw = explicitMatch[1].replace(/\s+/g, "");
    const firstNum = parseInt(raw.split(/[-~/]/)[0], 10);
    return {
      display: `${raw} V`,
      volts: Number.isFinite(firstNum) ? firstNum : null,
    };
  }

  // General voltage pattern: must NOT be preceded by letters or hyphen (e.g. avoid CNF-240\nVolts)
  const match = text.match(/(?<![A-Za-z0-9\-_])(\d{2,3}(?:\s*[-~/]\s*\d{2,3})?)\s*v(?:olts?|ac|~)?\b(?![A-Za-z])/i);
  if (!match) return null;

  const raw = match[1].replace(/\s+/g, "");
  const firstNum = parseInt(raw.split(/[-~/]/)[0], 10);
  return {
    display: `${raw} V`,
    volts: Number.isFinite(firstNum) ? firstNum : null,
  };
}

/** Extract Frequency in Hz (e.g. 60Hz, 50/60 Hz). */
export function extractFrequency(text: string): string | null {
  const match = text.match(/\b(\d{2}(?:\s*[/~]\s*\d{2})?)\s*hz\b/i);
  return match ? `${match[1].replace(/\s+/g, "")} Hz` : null;
}

/** Extract Current in Amperes (e.g. 1.2A, 5.5 A, 0.8 A). */
export function extractCurrent(text: string): number | null {
  const match = text.match(/(?:(?:rated\s*)?(?:current|input\s*current|amp(?:ere)?s?)|i)[:\s]*(\d+(?:\.\d+)?)\s*a\b/i) ??
    text.match(/\b(\d+(?:\.\d+)?)\s*a(?:mps?|mpere)?\b/i);

  if (!match) return null;
  const amps = parseFloat(match[1]);
  return Number.isFinite(amps) && amps > 0 && amps <= 100 ? amps : null;
}

/** Extract Energy Efficiency Rating (EER) or star rating. Must NOT be confused with wattage. */
export function extractEnergyEfficiencyRating(text: string): number | null {
  // e.g. "Energy Efficiency Rating: 253", "EER: 12.5", "Efficiency Rating: 253"
  // Evaluate line by line: "Issuance Year of Energy Rating: 2023" mentions "Energy Rating" but
  // its number is a year, not a rating, so lines about the issuance year are skipped entirely.
  const lines = text.split("\n").filter((line) => !/issuance|\byear\b/i.test(line));
  const patterns = [
    /\b(?:energy\s*efficiency\s*rating|energy\s*efficiency\s*ratio|efficiency\s*rating|eer)[^\d\n]{0,25}(\d{1,4}(?:\.\d+)?)\b/i,
    /\b(?:energy\s*rating)[^\d\n]{0,15}(\d{1,4}(?:\.\d+)?)\b/i,
  ];
  for (const pattern of patterns) {
    for (const line of lines) {
      const match = line.match(pattern);
      if (!match) continue;
      const val = parseFloat(match[1]);
      if (Number.isFinite(val) && val > 0 && val < 5000) return val;
    }
  }

  // Star rating e.g. "Star Rating: 5"
  const starMatch = text.match(/\b(?:star\s*rating)[:\s]+(\d+(?:\.\d+)?)\b/i);
  if (starMatch) {
    const val = parseFloat(starMatch[1]);
    if (Number.isFinite(val) && val >= 1 && val <= 10) return val;
  }

  return null;
}

/**
 * Extract Tested Energy Consumption in kWh/month, kWh/24h, or kWh/year (e.g. Yellow Energy Guide).
 */
export function extractTestedEnergy(text: string): {
  kwhMonth: number | null;
  kwh24h: number | null;
  kwhYear: number | null;
} {
  let kwhMonth: number | null = null;
  let kwh24h: number | null = null;
  let kwhYear: number | null = null;

  // 1. Monthly kWh: e.g. "Monthly Energy Consumption: 26.10 kWh", "24 kWh/month", "24.5 kwh/mo"
  const monthMatch =
    text.match(/(?:monthly(?:\s*energy)?\s*consumption|energy\s*consumption\s*per\s*month)[^\d\n]{0,15}(\d+(?:\.\d+)?)\s*kwh\b/i) ??
    text.match(/(\d+(?:\.\d+)?)\s*kwh\s*(?:\/|\s*per\s*)?\s*(?:month|mo)\b/i);
  if (monthMatch) {
    const val = parseFloat(monthMatch[1]);
    if (Number.isFinite(val) && val > 0 && val < 5000) {
      kwhMonth = val;
    }
  }

  // 2. 24-hour / daily test consumption: e.g. "0.85 kWh/24h", "based on kWh/24 hrs x 30 days"
  const dailyMatch =
    text.match(/(?:energy\s*consumption\s*\(?kwh\/24\s*h\)?|daily\s*energy\s*consumption)[^\d\n]{0,15}(\d+(?:\.\d+)?)\b/i) ??
    text.match(/(\d+(?:\.\d+)?)\s*kwh\s*(?:\/|\s*per\s*)?\s*(?:24\s*h(?:ours?|rs?)?|day)\b/i) ??
    text.match(/(?:based\s*on|spased\s*on)\s*(\d+(?:\.\d+)?)\s*kwh\/24/i);
  if (dailyMatch) {
    const val = parseFloat(dailyMatch[1]);
    if (Number.isFinite(val) && val > 0 && val < 200) {
      kwh24h = val;
      if (kwhMonth === null) {
        kwhMonth = Math.round(val * 30.4375 * 100) / 100;
      }
    }
  }

  // 3. Annual / Yearly kWh: e.g. "Annual Energy Consumption: 280 kWh/year", "280 kWh/annum"
  const yearMatch =
    text.match(/(?:annual(?:\s*energy)?\s*consumption|energy\s*consumption\s*per\s*year)[^\d\n]{0,15}(\d+(?:\.\d+)?)\s*kwh\b/i) ??
    text.match(/(\d+(?:\.\d+)?)\s*kwh\s*(?:\/|\s*per\s*)?\s*(?:year|yr|annum)\b/i);
  if (yearMatch) {
    const val = parseFloat(yearMatch[1]);
    if (Number.isFinite(val) && val > 0 && val < 60000) {
      kwhYear = val;
      if (kwhMonth === null) {
        kwhMonth = Math.round((val / 12) * 100) / 100;
      }
    }
  }

  return { kwhMonth, kwh24h, kwhYear };
}

/** Extract Cooling capacity in BTU/h or kJ/h. Must NOT be confused with input wattage. */
export function extractCoolingCapacity(text: string): number | null {
  const match = text.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*(?:btu(?:\/|\\|\s*per\s*)?h(?:r|our)?s?|btuh)\b/i);
  if (match) {
    const val = parseFloat(match[1].replace(/,/g, ""));
    return Number.isFinite(val) ? val : null;
  }
  return null;
}

/** Extract Motor or compressor horsepower (HP). Must NOT be confused with electrical input power. */
export function extractMotorHp(text: string): number | null {
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*(?:hp|horsepower)\b/i);
  if (match) {
    const val = parseFloat(match[1]);
    return Number.isFinite(val) && val <= 50 ? val : null;
  }
  return null;
}

/**
 * Deterministically extract rated electrical wattage in Watts.
 *
 * Distinguishes:
 * - Rated Input Power vs Cooling Capacity
 * - Rated Watts (W) vs kW (multiplied by 1000)
 * - Excludes kWh, Wh, BTU/h, V, Hz, A, HP
 * - Excludes model numbers like W-1200 or AC2000
 * - Excludes Energy Efficiency Rating numbers like 253
 */
export function extractWattage(text: string): {
  primaryWatts: number | null;
  candidates: WattageCandidate[];
} {
  const candidates: WattageCandidate[] = [];

  // 1. Look for explicit electrical input power:
  // e.g. "Rated Power Input: 850 W", "Power Input: 1200W", "Electric Consumption: 65W", "Rated Power: 0.5 kW"
  const inputPowerRegexes = [
    /(?:rated\s*(?:power\s*)?input|power\s*input|electric\s*power|rated\s*power|power\s*consumption|input\s*power|wattage|power)[:\s]*(\d+(?:\.\d+)?)\s*(w|kw)\b/gi,
  ];

  for (const regex of inputPowerRegexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const rawVal = parseFloat(match[1]);
      const unit = match[2].toLowerCase();
      const watts = unit === "kw" ? Math.round(rawVal * 1000) : rawVal;

      if (watts >= 1 && watts <= 20000) {
        const context = match[0].trim();
        if (!candidates.some((c) => Math.abs(c.value - watts) < 0.1)) {
          candidates.push({
            value: watts,
            label: `${watts} W (${unit === "kw" ? `${rawVal} kW` : `${rawVal} W`} rated input)`,
            context,
          });
        }
      }
    }
  }

  // 2. Specific cooling vs heating wattage:
  // e.g. "Cooling Input: 950 W", "Heating Input: 1100 W"
  const modePowerRegex = /(cooling|heating|wash|spin|motor|heater)\s*(?:power|input)?[:\s]*(\d+(?:\.\d+)?)\s*(w|kw)\b/gi;
  let modeMatch: RegExpExecArray | null;
  while ((modeMatch = modePowerRegex.exec(text)) !== null) {
    const mode = modeMatch[1];
    const rawVal = parseFloat(modeMatch[2]);
    const unit = modeMatch[3].toLowerCase();
    const watts = unit === "kw" ? Math.round(rawVal * 1000) : rawVal;
    if (watts >= 1 && watts <= 20000) {
      if (!candidates.some((c) => Math.abs(c.value - watts) < 0.1 && c.label.includes(mode))) {
        candidates.push({
          value: watts,
          label: `${watts} W (${mode} mode)`,
          context: modeMatch[0].trim(),
        });
      }
    }
  }

  // 3. General watts/kW patterns across the label:
  // Must NOT match:
  // - kWh, Wh (energy consumption)
  // - BTU/h, HP
  // - Model strings (e.g. "W1200", "ABC-500W")
  // - Energy Efficiency Rating
  const generalRegex = /(?<![A-Za-z0-9\-_])(\d+(?:\.\d+)?)\s*(w|kw)(?![A-Za-z0-9/])/gi;
  let genMatch: RegExpExecArray | null;
  while ((genMatch = generalRegex.exec(text)) !== null) {
    const startIndex = Math.max(0, genMatch.index - 30);
    const endIndex = Math.min(text.length, genMatch.index + 40);
    const windowText = text.slice(startIndex, endIndex);

    // Filter out if followed by 'h' or preceded by 'k' as in kWh
    if (/kwh/i.test(genMatch[0]) || /wh/i.test(genMatch[0]) && !/\bw\b/i.test(genMatch[2])) {
      continue;
    }
    // Filter out model number contexts
    if (/\b(?:model|mod|type|item|cat|p\/n|m\/n)[:\s]+[^,\n]*\b/i.test(windowText) && windowText.includes(genMatch[0])) {
      const modelCandidate = extractModel(windowText);
      if (modelCandidate && modelCandidate.includes(genMatch[1])) {
        continue;
      }
    }
    // Filter out cooling capacity in W if explicitly designated as cooling output
    if (/\b(?:cooling\s*capacity|capacity)[:\s]*\d+\s*w\b/i.test(windowText) && !/input/i.test(windowText)) {
      continue;
    }
    // Filter out EER contexts
    if (/\b(?:efficiency|rating|ratio|eer)\b/i.test(windowText) && !/power|input|watt/i.test(windowText)) {
      continue;
    }

    const rawVal = parseFloat(genMatch[1]);
    const unit = genMatch[2].toLowerCase();
    const watts = unit === "kw" ? Math.round(rawVal * 1000) : rawVal;

    if (watts >= 1 && watts <= 20000) {
      if (!candidates.some((c) => Math.abs(c.value - watts) < 0.1)) {
        candidates.push({
          value: watts,
          label: `${watts} W (${unit === "kw" ? `${rawVal} kW` : `${rawVal} W`})`,
          context: windowText.replace(/\s+/g, " ").trim(),
        });
      }
    }
  }

  let primaryWatts: number | null = null;
  if (candidates.length === 1) {
    primaryWatts = candidates[0].value;
  } else if (candidates.length > 1) {
    const inputCandidate = candidates.find((c) => /input|rated/i.test(c.label) || /input|rated/i.test(c.context));
    primaryWatts = inputCandidate ? inputCandidate.value : candidates[0].value;
  }

  return { primaryWatts, candidates };
}

/** Classify appliance label based on electrical specifications and energy efficiency indicators. */
export function classifyLabel(
  text: string,
  watts: number | null,
  wattageCandidates: WattageCandidate[],
  testedEnergy: { kwhMonth: number | null; kwh24h: number | null; kwhYear: number | null },
  eer: number | null,
  hasElectricalSpecs: boolean = false,
): LabelType {
  const hasWatts = (watts !== null && watts > 0) || wattageCandidates.length > 0;
  const hasElectrical = hasWatts || hasElectricalSpecs;
  const hasEnergyEfficiencyIndicators =
    testedEnergy.kwhMonth !== null ||
    testedEnergy.kwh24h !== null ||
    testedEnergy.kwhYear !== null ||
    eer !== null ||
    /\b(?:energy\s*label|energy\s*guide|energy\s*efficiency|star\s*rating|issuance\s*year\s*of\s*energy\s*rating|more\s*stars\s*and\s*higher\s*rating|frost-free\s*refrigerating\s*appliance)\b/i.test(text);

  if (hasElectrical && hasEnergyEfficiencyIndicators) return "MIXED";
  if (hasElectrical) return "ELECTRICAL_SPECIFICATION";
  if (hasEnergyEfficiencyIndicators) return "ENERGY_EFFICIENCY";
  return "UNKNOWN";
}

/**
 * Main parser: Extracts all specifications, classifies label, and runs deterministic validation.
 */
export function extractApplianceSpecs(rawText: string): ApplianceOcrResult {
  const text = cleanOcrText(rawText);
  const uncertainties: string[] = [];

  const brand = extractBrand(text);
  const model = extractModel(text);
  const { category, name } = extractCategoryAndName(text, brand);
  const voltage = extractVoltage(text);
  const frequency = extractFrequency(text);
  const currentAmps = extractCurrent(text);
  const { kwhMonth, kwh24h, kwhYear } = extractTestedEnergy(text);
  const energyEfficiencyRating = extractEnergyEfficiencyRating(text);
  const coolingBtuHr = extractCoolingCapacity(text);
  const motorHp = extractMotorHp(text);
  const { primaryWatts, candidates } = extractWattage(text);

  let finalWatts = primaryWatts;
  let isDerivedPower = false;
  let derivedPowerExplanation: string | null = null;

  // Classify label type
  const hasElectricalSpecs = Boolean(voltage || currentAmps || frequency);
  const labelType = classifyLabel(
    text,
    finalWatts,
    candidates,
    { kwhMonth, kwh24h, kwhYear },
    energyEfficiencyRating,
    hasElectricalSpecs,
  );

  // Determine consumption calculation basis
  let consumptionBasis: ConsumptionBasis = "none";
  if (finalWatts !== null && finalWatts > 0) {
    consumptionBasis = "wattage";
  } else if (kwhMonth !== null) {
    consumptionBasis = "monthly_test";
  } else if (kwh24h !== null) {
    consumptionBasis = "daily_test";
  } else if (kwhYear !== null) {
    consumptionBasis = "annual_test";
  }

  // Handle derived apparent power if wattage is missing on electrical specs with V & A
  if (finalWatts === null && voltage?.volts && currentAmps && labelType === "ELECTRICAL_SPECIFICATION") {
    const apparentWatts = Math.round(voltage.volts * currentAmps);
    finalWatts = apparentWatts;
    isDerivedPower = true;
    consumptionBasis = "wattage";
    derivedPowerExplanation = `Inferred apparent power: ${voltage.volts} V × ${currentAmps} A = ${apparentWatts} VA (assumes power factor ≈ 1.0). Actual active power (watts) may vary. Please confirm.`;
    uncertainties.push(`Wattage estimated from voltage and current (${apparentWatts} VA). Please verify.`);
  }

  if (coolingBtuHr && !finalWatts) {
    uncertainties.push(`Detected cooling capacity of ${coolingBtuHr.toLocaleString()} BTU/h, but not electrical input watts. Do not enter BTU/h as wattage.`);
  }

  if (motorHp && !finalWatts) {
    uncertainties.push(`Detected motor capacity of ${motorHp} HP. Motor horsepower is not electrical input wattage.`);
  }

  if (candidates.length > 1) {
    uncertainties.push(`Found ${candidates.length} wattage candidates (${candidates.map((c) => `${c.value}W`).join(", ")}). Please select the correct operating power.`);
  }

  // If label is ENERGY_EFFICIENCY: explain that watts are genuinely not on this label
  if (labelType === "ENERGY_EFFICIENCY") {
    if (kwhMonth !== null) {
      uncertainties.push(`Energy Efficiency Guide / Label: Rated input watts are not printed on this label type. Using verified manufacturer tested consumption of ${kwhMonth} kWh/month.`);
    } else {
      uncertainties.push("Energy efficiency label detected, but tested consumption was not clear. Please verify the value.");
    }
  } else if (!finalWatts && kwhMonth === null) {
    uncertainties.push("No rated wattage could be confirmed from the label. Please enter it manually.");
  }

  // Calculate confidence
  let confidence: "high" | "medium" | "low" = "high";
  if (labelType === "ENERGY_EFFICIENCY") {
    confidence = kwhMonth !== null ? (brand && model ? "high" : "medium") : "low";
  } else if (!finalWatts || candidates.length > 1 || isDerivedPower) {
    confidence = finalWatts && !isDerivedPower ? "medium" : "low";
  } else if (!brand || !model) {
    confidence = "medium";
  }

  return {
    rawText,
    labelType,
    consumptionBasis,
    brand,
    model,
    name,
    category,
    watts: finalWatts,
    wattageCandidates: candidates,
    voltage: voltage?.display ?? null,
    frequency,
    currentAmps,
    testedKwhMonth: kwhMonth,
    testedKwh24h: kwh24h,
    testedKwhYear: kwhYear,
    energyEfficiencyRating,
    coolingBtuHr,
    motorHp,
    isDerivedPower,
    derivedPowerExplanation,
    uncertainties,
    confidence,
  };
}

/** Preprocess image on a Canvas: support rotation by 0, 90, 180, 270 degrees. */
export function rotateCanvas(
  sourceImage: HTMLImageElement | HTMLCanvasElement,
  angleDegrees: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not initialize 2D canvas context.");

  const rad = ((angleDegrees % 360) * Math.PI) / 180;
  const isPerpendicular = Math.abs(angleDegrees % 180) === 90;

  canvas.width = isPerpendicular ? sourceImage.height : sourceImage.width;
  canvas.height = isPerpendicular ? sourceImage.width : sourceImage.height;

  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(sourceImage, -sourceImage.width / 2, -sourceImage.height / 2);

  return canvas;
}

/**
 * Enhanced preprocessing helper for small, dim, or low-contrast specification and energy labels.
 * Upscales small images for clearer character boundaries, performs contrast enhancement,
 * and maintains aspect ratio.
 */
export function enhanceCanvasForOcr(sourceCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const scale = sourceCanvas.width < 1200 ? 1.5 : 1;
  const targetWidth = Math.round(sourceCanvas.width * scale);
  const targetHeight = Math.round(sourceCanvas.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return sourceCanvas;

  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);

  try {
    const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight);
    const data = imgData.data;

    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (gray < min) min = gray;
      if (gray > max) max = gray;
    }

    const range = max - min || 1;
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const normalized = Math.min(255, Math.max(0, ((gray - min) / range) * 255));
      data[i] = normalized;
      data[i + 1] = normalized;
      data[i + 2] = normalized;
    }

    ctx.putImageData(imgData, 0, 0);
  } catch {
    // Graceful fallback
  }

  return canvas;
}

/** A recognized word and its box in image pixels. */
export interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

type TessWord = { text?: string; confidence?: number; bbox?: OcrWord["bbox"] };
type TessBlock = { paragraphs?: { lines?: { words?: TessWord[] }[] }[] };

function wordsFromBlocks(blocks: unknown): OcrWord[] {
  if (!Array.isArray(blocks)) return [];
  const out: OcrWord[] = [];
  for (const block of blocks as TessBlock[]) {
    for (const p of block.paragraphs ?? []) for (const line of p.lines ?? []) for (const w of line.words ?? []) {
      if (w.text && w.text.trim() && w.bbox) out.push({ text: w.text.trim(), confidence: w.confidence ?? 0, bbox: w.bbox });
    }
  }
  return out;
}

/**
 * Words worth highlighting (Lens-style): the ones that produced a detected spec.
 * Returns the index of each highlighted word and which spec it belongs to.
 */
export function highlightWords(words: OcrWord[], specs: ApplianceOcrResult): Map<number, string> {
  const hits = new Map<number, string>();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]/g, "");
  const numberIn = (s: string) => {
    const m = s.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.011 * Math.max(1, Math.abs(b));
  const voltsNumber = specs.voltage ? numberIn(specs.voltage) : null;
  words.forEach((w, i) => {
    const t = norm(w.text);
    const n = numberIn(w.text);
    const next = words[i + 1] ? norm(words[i + 1].text) : "";
    const unit = `${t} ${next}`;
    if (specs.brand && t && specs.brand.split(/\s+/).map(norm).some((b) => b && t === b)) hits.set(i, "brand");
    else if (specs.model && t.length >= 3 && norm(specs.model).includes(t)) hits.set(i, "model");
    else if (n != null && specs.watts != null && near(n, specs.watts) && /w\b|watt|w$/.test(unit) && !/kwh/.test(t)) hits.set(i, "watts");
    else if (n != null && specs.testedKwhMonth != null && near(n, specs.testedKwhMonth)) hits.set(i, "kwh");
    else if (n != null && voltsNumber != null && near(n, voltsNumber) && /v/.test(unit)) hits.set(i, "volts");
    else if (n != null && specs.energyEfficiencyRating != null && near(n, specs.energyEfficiencyRating)) hits.set(i, "eer");
    else if (/^(watts?|w|kwh|v|volts?|hz)$/.test(t) && hits.has(i - 1)) hits.set(i, hits.get(i - 1)!);
  });
  return hits;
}

/**
 * Recognize an appliance label image using Tesseract.js with live progress reporting.
 */
export async function recognizeApplianceLabel(
  imageSource: File | HTMLCanvasElement,
  onProgress?: (progress: { stage: string; percent: number }) => void,
): Promise<{ text: string; specs: ApplianceOcrResult; words: OcrWord[] }> {
  if (imageSource instanceof File) {
    if (!imageSource.type.startsWith("image/")) {
      throw new Error("Please select an image file (PNG, JPG, WebP), or enter details manually.");
    }
    if (imageSource.size > 15 * 1024 * 1024) {
      throw new Error("The image file is too large (maximum 15 MB). Please select a smaller photo.");
    }
  }

  onProgress?.({ stage: "Loading OCR engine…", percent: 10 });
  const { createWorker } = await import("tesseract.js");

  const worker = await createWorker("eng", 1, {
    logger: (m) => {
      if (m.status === "recognizing text" && typeof m.progress === "number") {
        onProgress?.({ stage: "Scanning appliance label…", percent: Math.round(m.progress * 80) + 15 });
      }
    },
  });

  try {
    onProgress?.({ stage: "Recognizing specifications…", percent: 30 });
    // blocks: true -> word bounding boxes, used for the Google Lens-style highlight overlay.
    const { data } = await worker.recognize(imageSource, {}, { text: true, blocks: true } as never);
    onProgress?.({ stage: "Extracting electrical ratings…", percent: 95 });
    const text = data.text;
    const specs = extractApplianceSpecs(text);
    onProgress?.({ stage: "Complete", percent: 100 });
    return { text, specs, words: wordsFromBlocks((data as { blocks?: unknown }).blocks) };
  } finally {
    await worker.terminate();
  }
}
