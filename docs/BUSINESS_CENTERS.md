# Meralco Business Center locator — data and maintenance

**Location in app:** Help & Support → Meralco Business Centers (`locator.js`, `src/lib/locator.ts`).
**Data file:** `src/data/meralco-business-centers.ts`
**Source:** https://www.meralco.com.ph/help/meralco-business-centers (page states "52 centers in 7 areas. Updated 23 October 2026"). Transcribed 2026-11-12.

## What is stored (and what is not)
| Field | Rule |
|---|---|
| name, address, locality, area | Exactly as published. |
| phone | The per-branch "Call" number exactly as published (e.g. `1622 6584`). `null` for the 7 centers with no call button. Never filled with the general hotline. |
| googlePlaceId | From the page's "Open in Google Maps" link. Used only for directions links. |
| coordinates | Only when the page publishes them (San Miguel). All others are `null`. |
| hours | **Not stored** — the source page does not publish operating hours. The UI shows "Not published". |

The general Meralco hotline ((02) 16211) is shown separately and labelled as a general line, not a branch number.

## Map behaviour
- No `VITE_MAPBOX_ACCESS_TOKEN`: the searchable list, details, contact and directions links work; a neutral "map not configured" notice is shown.
- With a token: Mapbox GL JS is loaded on demand. Centers without published coordinates are geocoded from their **published address** with the Mapbox Geocoding API and labelled "Approximate — geocoded from the published address". Results are cached in the browser (`smartwatts-geocode-v1`). Published coordinates are never overwritten.
- Use a **public** (`pk.*`) token restricted to your domains. Live map rendering has not been tested yet because no token is configured.

## Refresh procedure
1. Open the source page and compare the count and each entry against the data file.
2. Update entries exactly as published; do not infer hours, phones, or coordinates.
3. Update `sourceUpdated`, `lastVerified`, and `publishedCount` in `BUSINESS_CENTERS_SOURCE`.
4. Clear the geocode cache key if addresses changed (bump `smartwatts-geocode-v1` to `-v2` in `locator.js`).
5. Run `npx vitest run src/lib/locator.test.ts` and `npx playwright test e2e/locator.spec.ts`.
