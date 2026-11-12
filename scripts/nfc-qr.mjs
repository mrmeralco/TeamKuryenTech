#!/usr/bin/env node
// Generates the QR-code fallback for the SmartWatts NFC card (same URL as the NFC NDEF record).
//
//   node scripts/nfc-qr.mjs https://<verified-smartwatts-domain>/nfc [output-basename]
//
// Writes <basename>.svg and <basename>.png (default: docs/nfc/smartwatts-nfc-qr).
// Refuses anything but a plain HTTPS /nfc URL so no credentials or local hosts end up on a card.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import QRCode from "qrcode";

const [raw, out = "docs/nfc/smartwatts-nfc-qr"] = process.argv.slice(2);

export function validateCardUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Pass the full card URL, e.g. https://smartwatts.example.com/nfc");
  }
  if (url.protocol !== "https:") throw new Error("Card URLs must use HTTPS.");
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".local")) {
    throw new Error("A local address cannot be put on a physical card.");
  }
  if (url.username || url.password) throw new Error("Card URLs must not contain credentials.");
  if (url.pathname.replace(/\/$/, "") !== "/nfc") throw new Error("Card URLs must point at /nfc.");
  for (const key of url.searchParams.keys()) {
    if (key !== "p") throw new Error(`Unexpected query parameter "${key}". Only the optional opaque property hint "p" is allowed.`);
  }
  if (url.hash) throw new Error("Card URLs must not contain a fragment.");
  return url.toString();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!raw) {
    console.error("Usage: node scripts/nfc-qr.mjs https://<verified-smartwatts-domain>/nfc [output-basename]");
    process.exit(2);
  }
  try {
    const url = validateCardUrl(raw);
    mkdirSync(dirname(out), { recursive: true });
    const options = { errorCorrectionLevel: "M", margin: 2, color: { dark: "#2b1d0eff", light: "#ffffffff" } };
    await QRCode.toFile(`${out}.svg`, url, { ...options, type: "svg" });
    await QRCode.toFile(`${out}.png`, url, { ...options, type: "png", width: 1024 });
    console.log(`QR for ${url}\n  ${out}.svg\n  ${out}.png`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
