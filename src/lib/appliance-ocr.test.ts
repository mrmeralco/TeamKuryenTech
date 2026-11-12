import { describe, expect, it } from "vitest";
import { extractApplianceSpecs } from "./appliance-ocr";

describe("Deterministic Electrical Specification Extraction", () => {
  it("normalizes 65W to 65 watts", () => {
    const text = "Brand: Standard\nElectric Stand Fan\nRated Power: 65W\n220V 60Hz";
    const specs = extractApplianceSpecs(text);
    expect(specs.watts).toBe(65);
    expect(specs.brand).toBe("Standard");
    expect(specs.category).toBe("cooling");
    expect(specs.voltage).toBe("220 V");
    expect(specs.frequency).toBe("60 Hz");
    expect(specs.isDerivedPower).toBe(false);
  });

  it("normalizes 0.5kW to 500 watts", () => {
    const text = "Panasonic Microwave Oven\nModel: NN-ST25JW\nRated Input: 0.5 kW\n230V 60Hz";
    const specs = extractApplianceSpecs(text);
    expect(specs.watts).toBe(500);
    expect(specs.brand).toBe("Panasonic");
    expect(specs.model).toBe("NN-ST25JW");
    expect(specs.category).toBe("cooking");
    expect(specs.voltage).toBe("230 V");
    expect(specs.isDerivedPower).toBe(false);
  });

  it("normalizes 1.2 kW to 1200 watts", () => {
    const text = "Carrier Inverter Air Conditioner\nRated Input: 1.2kW\n230V ~ 60Hz";
    const specs = extractApplianceSpecs(text);
    expect(specs.watts).toBe(1200);
    expect(specs.brand).toBe("Carrier");
    expect(specs.category).toBe("cooling");
  });

  it("identifies 220V as voltage and never as power", () => {
    const text = "Voltage: 220V\nFrequency: 60Hz\nMade in Philippines";
    const specs = extractApplianceSpecs(text);
    expect(specs.voltage).toBe("220 V");
    expect(specs.watts).toBeNull();
    expect(specs.uncertainties).toContain("No rated wattage could be confirmed from the label. Please enter it manually.");
  });

  it("identifies 60Hz as frequency and never as power", () => {
    const text = "220-240V 60Hz 1.5A";
    const specs = extractApplianceSpecs(text);
    expect(specs.frequency).toBe("60 Hz");
    expect(specs.watts).not.toBe(60);
  });

  it("identifies 1.2A as current, not verified real power, and derives apparent power with explicit disclosure", () => {
    const text = "Condura Refrigerator\nModel: CR-180\n220V 60Hz\nRated Current: 1.2A";
    const specs = extractApplianceSpecs(text);
    expect(specs.currentAmps).toBe(1.2);
    expect(specs.voltage).toBe("220 V");
    // Inferred apparent power = 220 * 1.2 = 264 VA
    expect(specs.watts).toBe(264);
    expect(specs.isDerivedPower).toBe(true);
    expect(specs.derivedPowerExplanation).toContain("Inferred apparent power: 220 V × 1.2 A = 264 VA");
    expect(specs.derivedPowerExplanation).toContain("assumes power factor ≈ 1.0");
    expect(specs.confidence).toBe("low");
  });

  it("extracts 24 kWh/month as tested energy consumption, not as rated wattage", () => {
    const text = `
      ENERGY GUIDE
      Department of Energy
      Household Refrigerator
      Brand: Condura
      Model: CNF-220
      Monthly Energy Consumption: 24 kWh/month
      Tested in accordance with Philippine National Standards
      Rated Power Input: 85 W
      220V 60Hz
    `;
    const specs = extractApplianceSpecs(text);
    expect(specs.testedKwhMonth).toBe(24);
    expect(specs.watts).toBe(85);
    expect(specs.watts).not.toBe(24);
    expect(specs.brand).toBe("Condura");
    expect(specs.model).toBe("CNF-220");
    expect(specs.category).toBe("refrigeration");
  });

  it("does not confuse cooling capacity BTU/h with electrical input wattage", () => {
    const text = `
      Carrier Split-Type Air Conditioner
      Model: FP-53CAS010308
      Cooling Capacity: 9,500 BTU/h
      Power Input: 820 W
      230V 60Hz
      Rated Current: 3.8 A
    `;
    const specs = extractApplianceSpecs(text);
    expect(specs.coolingBtuHr).toBe(9500);
    expect(specs.watts).toBe(820);
    expect(specs.watts).not.toBe(9500);
    expect(specs.brand).toBe("Carrier");
    expect(specs.model).toBe("FP-53CAS010308");
    expect(specs.category).toBe("cooling");
  });

  it("does not confuse motor horsepower (HP) with electrical input wattage", () => {
    const text = `
      Whirlpool Washing Machine
      Model: AWM-700
      Motor: 0.5 HP
      Rated Power: 350 W
      220V 60Hz
    `;
    const specs = extractApplianceSpecs(text);
    expect(specs.motorHp).toBe(0.5);
    expect(specs.watts).toBe(350);
    expect(specs.watts).not.toBe(0.5);
  });

  it("does not mistake model numbers with misleading digits as wattage", () => {
    const text = `
      Samsung Smart TV
      Model No.: UA55AU7000W
      220-240V 50/60Hz
      Power Consumption: 145W
    `;
    const specs = extractApplianceSpecs(text);
    expect(specs.model).toBe("UA55AU7000W");
    expect(specs.watts).toBe(145);
    expect(specs.watts).not.toBe(55);
    expect(specs.watts).not.toBe(7000);
    expect(specs.category).toBe("entertainment");
  });

  it("handles model numbers prefixed with W or numbers like W-1200", () => {
    const text = `
      Sharp Electric Oven
      Model: W-1200X
      Voltage: 220V
      Rated Input: 1500W
    `;
    const specs = extractApplianceSpecs(text);
    expect(specs.model).toBe("W-1200X");
    expect(specs.watts).toBe(1500);
    expect(specs.watts).not.toBe(1200);
  });

  it("detects and flags multiple conflicting wattage candidates", () => {
    const text = `
      Carrier Inverter Split Air Conditioner
      Model: 42QHG012
      Cooling Input: 950 W
      Heating Input: 1200 W
      Rated Current: 4.5 A
      220-240V 60Hz
    `;
    const specs = extractApplianceSpecs(text);
    expect(specs.wattageCandidates.length).toBeGreaterThanOrEqual(2);
    expect(specs.wattageCandidates.map((c) => c.value)).toContain(950);
    expect(specs.wattageCandidates.map((c) => c.value)).toContain(1200);
    expect(specs.uncertainties.some((u) => u.includes("wattage candidates"))).toBe(true);
    expect(specs.confidence).toBe("medium");
  });

  it("parses annual kWh/year and converts to approximate monthly tested kWh", () => {
    const text = "LG Inverter Refrigerator\nAnnual Energy Consumption: 288 kWh/year\nRated Power: 70 W\n230V 60Hz";
    const specs = extractApplianceSpecs(text);
    expect(specs.testedKwhYear).toBe(288);
    expect(specs.testedKwhMonth).toBe(24); // 288 / 12
    expect(specs.watts).toBe(70);
  });

  it("handles noisy or poorly formatted OCR text", () => {
    const noisyText = `
      S A M S U N G
      INVERTER REF   CNF-240
      Volts: 220 V ~
      Hz: 60Hz
      Watt: 110 W
      R134a
    `;
    const specs = extractApplianceSpecs(noisyText);
    expect(specs.watts).toBe(110);
    expect(specs.voltage).toBe("220 V");
    expect(specs.frequency).toBe("60 Hz");
    expect(specs.category).toBe("refrigeration");
  });

  it("handles label with only BTU/h and no wattage by warning user", () => {
    const text = "Carrier Aircon\nCooling: 12,000 BTU/h\n220V 60Hz";
    const specs = extractApplianceSpecs(text);
    expect(specs.coolingBtuHr).toBe(12000);
    expect(specs.watts).toBeNull();
    expect(specs.uncertainties.some((u) => u.includes("BTU/h"))).toBe(true);
  });

  describe("Real-World Philippine Refrigerator Energy Efficiency Label Regression", () => {
    it("correctly parses real Philippine DOE Energy Guide refrigerator label without inventing wattage", () => {
      // Exact OCR transcript from tests/fixtures/ph-refrigerator-energy-label.jpg
      const realOcrText = `
ENERGY GUIDE
DOE / Department of Energy
ENERGY EFFICIENCY
Monthly Energy Consumption™: 26.10 kWh
*spased on kWhi24 he 30 days: 0.87 kWh/24h
Energy Efficiency Rating: 253
Brand Name: LG
Product Model: GR-B202SQBB
~ Frost-Free Refrigerati | I pe ting Appliance
Volume (liters): 187.0
      `;

      const specs = extractApplianceSpecs(realOcrText);

      // Label classification
      expect(specs.labelType).toBe("ENERGY_EFFICIENCY");
      expect(specs.consumptionBasis).toBe("monthly_test");

      // Identification fields
      expect(specs.brand).toBe("LG");
      expect(specs.model).toBe("GR-B202SQBB");
      expect(specs.category).toBe("refrigeration");

      // Energy consumption fields
      expect(specs.testedKwhMonth).toBe(26.1);
      expect(specs.testedKwh24h).toBe(0.87);
      expect(specs.energyEfficiencyRating).toBe(253);

      // Electrical wattage verification: NO wattage exists on this energy label
      expect(specs.watts).toBeNull();
      expect(specs.isDerivedPower).toBe(false);

      // Ensure EER 253, liters 187, or kWh 26.1 are NEVER confused with watts
      expect(specs.watts).not.toBe(253);
      expect(specs.watts).not.toBe(187);
      expect(specs.watts).not.toBe(26.1);

      // Information notice explains why wattage is missing and that tested kWh can be used
      expect(specs.uncertainties.some((u) => u.includes("Energy Efficiency Guide") && u.includes("26.1 kWh/month"))).toBe(true);
      expect(specs.confidence).toBe("high");
    });

    it("parses daily kWh/24h when monthly kWh is not explicitly given", () => {
      const text = `
        ENERGY GUIDE
        Brand Name: Samsung
        Model: RT20FARVDSA
        Daily Energy Consumption: 0.85 kWh/24h
        Energy Efficiency Rating: 280
        No-Frost Refrigerator
      `;
      const specs = extractApplianceSpecs(text);
      expect(specs.labelType).toBe("ENERGY_EFFICIENCY");
      expect(specs.testedKwh24h).toBe(0.85);
      // 0.85 * 30.4375 ≈ 25.87
      expect(specs.testedKwhMonth).toBeCloseTo(25.87, 1);
      expect(specs.energyEfficiencyRating).toBe(280);
      expect(specs.watts).toBeNull();
      expect(specs.category).toBe("refrigeration");
    });

    it("classifies mixed label containing both electrical rating plate wattage and energy consumption", () => {
      const text = `
        Panasonic Refrigerator
        Model: NR-BP230VD
        Rated Power Input: 75 W
        230V 60Hz 0.65A
        Monthly Energy Consumption: 21.5 kWh/month
        Energy Efficiency Rating: 320
      `;
      const specs = extractApplianceSpecs(text);
      expect(specs.labelType).toBe("MIXED");
      expect(specs.consumptionBasis).toBe("wattage");
      expect(specs.watts).toBe(75);
      expect(specs.testedKwhMonth).toBe(21.5);
      expect(specs.energyEfficiencyRating).toBe(320);
      expect(specs.voltage).toBe("230 V");
      expect(specs.frequency).toBe("60 Hz");
    });

    it("classifies pure electrical rating plate as ELECTRICAL_SPECIFICATION", () => {
      const text = `
        Midea Window Type Air Conditioner
        Model: FP-51ARA010HEIV-N5
        Rated Voltage: 230 V
        Rated Frequency: 60 Hz
        Rated Power Input: 920 W
        Rated Current: 4.2 A
        Refrigerant: R32
      `;
      const specs = extractApplianceSpecs(text);
      expect(specs.labelType).toBe("ELECTRICAL_SPECIFICATION");
      expect(specs.consumptionBasis).toBe("wattage");
      expect(specs.watts).toBe(920);
      expect(specs.voltage).toBe("230 V");
      expect(specs.frequency).toBe("60 Hz");
      expect(specs.testedKwhMonth).toBeNull();
    });
  });
});

describe("Actual Tesseract output for tests/fixtures/ph-refrigerator-energy-label.jpg", () => {
  // Captured from the running app (Tesseract.js, eng) on 2026-11-12. The printed rating "253"
  // is not legible to OCR, while "Issuance Year of Energy Rating: 2023" is.
  const actualOcrText = String.raw`ng. RE TEE
ENEE _—
= | == - Dd eA, 4 —
zs NER = ADE =
~ Frost-Fre : »] =]
-Free Refrigerating Appliz
Energy y Efficiency Rating: ~~
) < bh
, nder standard test conditions — J
4 »
=! Ye ’s / :
< ~~ gla - — <<" ——
\ / \ 4 \ /
! \ I A yp |
pd PET BE 2s
“More stars and higher rating means more savings”
Issuance Year of Energy Rating: 2023
Monthly Energy Consumption™: 26.10 kWh
Brand Name: LG
Product Model: GR-B202SQBB
Volume (liters): 187.0
Coldness Star Ratirig: ETE
Refrigerant’ R600a (GWP < 1) pased on kWh/24 hrs x 30.2
For more ii Maleg pei | SE lig Nos 2:
SELON by 1, Thies or Altering of te = Mk I Je subje
Pd cre THe he 0 rfonass2 ELEC
`;

  it("extracts the tested monthly consumption and never treats the issuance year as the rating", () => {
    const specs = extractApplianceSpecs(actualOcrText);
    expect(specs.brand).toBe("LG");
    expect(specs.model).toBe("GR-B202SQBB");
    expect(specs.category).toBe("refrigeration");
    expect(specs.name).toBe("LG Refrigerator");
    expect(specs.labelType).toBe("ENERGY_EFFICIENCY");
    expect(specs.consumptionBasis).toBe("monthly_test");
    expect(specs.testedKwhMonth).toBe(26.1);
    expect(specs.watts).toBeNull();
    expect(specs.energyEfficiencyRating).not.toBe(2023);
    expect(specs.energyEfficiencyRating).toBeNull();
  });
});
