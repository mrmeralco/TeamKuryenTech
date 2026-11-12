import { describe, expect, it } from "vitest";
import { extractApplianceSpecs, highlightWords, type OcrWord } from "./appliance-ocr";

const word = (text: string, i: number): OcrWord => ({ text, confidence: 90, bbox: { x0: i * 10, y0: 0, x1: i * 10 + 8, y1: 10 } });

describe("highlightWords (Lens-style overlay)", () => {
  it("highlights the words behind the detected brand, power and voltage", () => {
    const text = "SAMSUNG\nModel AR09TYHYEWKN\nRated Input Power 820 W\nRated Voltage 220-240V ~ 60Hz";
    const specs = extractApplianceSpecs(text);
    const words = text.split(/\s+/).map(word);
    const hits = highlightWords(words, specs);
    const kinds = new Map([...hits].map(([i, kind]) => [words[i].text, kind]));
    expect(kinds.get("SAMSUNG")).toBe("brand");
    if (specs.watts === 820) expect(kinds.get("820")).toBe("watts");
    expect([...hits.values()]).toContain("brand");
  });

  it("returns nothing when no specs were recognized", () => {
    const specs = extractApplianceSpecs("hello world");
    expect(highlightWords(["hello", "world"].map(word), specs).size).toBe(0);
  });
});
