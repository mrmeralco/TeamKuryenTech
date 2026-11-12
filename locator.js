// Help & Support → Meralco Business Centers.
// The searchable directory always works. The Mapbox map loads only when
// VITE_MAPBOX_ACCESS_TOKEN is configured; otherwise a neutral notice is shown.
import { BUSINESS_CENTERS, BUSINESS_CENTERS_SOURCE } from "./src/data/meralco-business-centers.ts";
import { areas, directionsUrl, filterCenters, GENERAL_HOTLINE, LocatorController, phoneHref } from "./src/lib/locator.ts";
import { esc, notice } from "./ui-kit.js";

const MAPBOX_TOKEN = (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? "").trim();
const GEOCODE_CACHE_KEY = "smartwatts-geocode-v1";
let controller = null;
let mapAdapter = null;
let state = { query: "", area: "" };

function detailHtml(center) {
  const phone = phoneHref(center.phone);
  const position = controller?.position(center.id);
  return `
    <h3 translate="no">${esc(center.name)}</h3>
    <div class="detail-list">
      <div class="detail-row"><span>Address</span><b translate="no">${esc(center.address)}</b></div>
      <div class="detail-row"><span>City / province</span><b translate="no">${esc(center.locality)}</b></div>
      <div class="detail-row"><span>Area</span><b translate="no">${esc(center.area)}</b></div>
      <div class="detail-row"><span>Operating hours</span><b>Not published</b></div>
      <div class="detail-row"><span>Branch contact (as published)</span><b>${phone ? `<a href="${phone}" translate="no">${esc(center.phone)}</a>` : "Not published"}</b></div>
      ${center.email ? `<div class="detail-row"><span>Email (as published)</span><b><a href="mailto:${esc(center.email)}" translate="no">${esc(center.email)}</a></b></div>` : ""}
      <div class="detail-row"><span>Map position</span><b>${position ? (position.precision === "published" ? "Published by Meralco (approximate)" : "Approximate — geocoded from the published address") : "Not available"}</b></div>
    </div>
    <div class="toolbar" style="margin-top:12px">
      <a class="btn btn-primary" href="${esc(directionsUrl(center))}" target="_blank" rel="noopener noreferrer">Get directions</a>
    </div>`;
}

function listHtml(results) {
  if (!results.length) return `<p class="muted-note">No Business Centers match your search.</p>`;
  return `<ul class="center-list" aria-label="Meralco Business Centers">${results
    .map((center) => `<li><button type="button" class="center-item${controller?.selectedId === center.id ? " active" : ""}" data-act="center-select" data-id="${esc(center.id)}" aria-pressed="${controller?.selectedId === center.id}">
      <b translate="no">${esc(center.name.replace("Meralco Business Center - ", ""))}</b>
      <small translate="no">${esc(center.locality)}</small></button></li>`)
    .join("")}</ul>`;
}

function refreshList() {
  const results = filterCenters(state.query, state.area);
  const list = document.querySelector('[data-slot="center-list"]');
  const count = document.querySelector('[data-slot="center-count"]');
  if (list) list.innerHTML = listHtml(results);
  if (count) count.textContent = `${results.length} of ${BUSINESS_CENTERS.length} centers`;
  controller?.renderMarkers(results);
}

function showDetails(center) {
  const target = document.querySelector('[data-slot="center-detail"]');
  if (target) target.innerHTML = detailHtml(center);
  document.querySelectorAll(".center-item").forEach((button) => {
    const active = button.dataset.id === center.id;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function readGeocodeCache() {
  try {
    return JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

async function geocodeMissing() {
  const cache = readGeocodeCache();
  for (const center of BUSINESS_CENTERS) {
    if (controller.position(center.id)) continue;
    let hit = cache[center.id];
    if (!hit) {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(center.address)}.json?country=ph&limit=1&access_token=${encodeURIComponent(MAPBOX_TOKEN)}`;
      try {
        const response = await fetch(url);
        const feature = response.ok ? (await response.json()).features?.[0] : null;
        if (!feature) continue;
        hit = { lng: feature.center[0], lat: feature.center[1] };
        cache[center.id] = hit;
      } catch {
        continue;
      }
    }
    controller.setPosition(center.id, { ...hit, precision: "geocoded" });
  }
  try {
    localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Cache is optional.
  }
  refreshList();
}

async function initMap(container) {
  const [{ default: mapboxgl }] = await Promise.all([import("mapbox-gl"), import("mapbox-gl/dist/mapbox-gl.css")]);
  mapboxgl.accessToken = MAPBOX_TOKEN;
  const map = new mapboxgl.Map({ container, style: "mapbox://styles/mapbox/streets-v12", center: [121.0, 14.6], zoom: 8 });
  map.addControl(new mapboxgl.NavigationControl(), "top-right");
  const markers = new Map();
  mapAdapter = {
    setMarkers(items) {
      markers.forEach((marker) => marker.remove());
      markers.clear();
      for (const item of items) {
        const element = document.createElement("button");
        element.type = "button";
        element.className = "center-marker";
        element.setAttribute("aria-label", item.label);
        element.addEventListener("click", () => controller.select(item.id));
        markers.set(item.id, new mapboxgl.Marker({ element }).setLngLat([item.position.lng, item.position.lat]).addTo(map));
      }
    },
    focus(id, position) {
      map.flyTo({ center: [position.lng, position.lat], zoom: 14 });
      markers.forEach((marker, markerId) => marker.getElement().classList.toggle("active", markerId === id));
    },
  };
  return mapAdapter;
}

function centersPage(ctx) {
  return `
    ${ctx.pageHead("Meralco Business Centers", "Find a Meralco Business Center near you.")}
    <div class="grid locator-layout">
      ${ctx.panel("Search", `
        <div class="form-grid">
          <div class="field"><label>Branch, city, or province<input type="search" data-locator="query" autocomplete="off" placeholder="e.g. Makati"></label></div>
          <div class="field"><label>Province / area<select class="select" data-locator="area"><option value="">All areas</option>${areas().map((area) => `<option value="${esc(area)}">${esc(area)}</option>`).join("")}</select></label></div>
        </div>
        <p class="muted-note" data-slot="center-count" aria-live="polite"></p>
        <div data-slot="center-list"></div>`)}
      <div class="locator-side">
        ${ctx.panel("Map", `<div data-slot="center-map">${MAPBOX_TOKEN
          ? `<div class="locator-map" id="locatorMap" role="region" aria-label="Map of Meralco Business Centers"></div>`
          : notice("info", "The interactive map is not configured. Use the searchable directory; directions links open in your maps app.")}</div>`)}
        ${ctx.panel("Branch details", `<div data-slot="center-detail"><p class="muted-note">Select a Business Center to see its details.</p></div>`)}
        ${ctx.panel("General customer support", `
          <p class="stat-foot">Meralco general customer hotline: <a href="${GENERAL_HOTLINE.href}" translate="no">${GENERAL_HOTLINE.display}</a>. This is a general line, not a direct branch number.</p>`)}
      </div>
    </div>
    <p class="muted-note">Source: <a href="${BUSINESS_CENTERS_SOURCE.url}" target="_blank" rel="noopener noreferrer">official Meralco Business Center directory</a> (page updated ${BUSINESS_CENTERS_SOURCE.sourceUpdated}; last checked by SmartWatts ${BUSINESS_CENTERS_SOURCE.lastVerified}). Operating hours are not published there. Confirm details with Meralco before visiting. SmartWatts is not affiliated with Meralco.</p>`;
}

async function loadCenters(_ctx, root) {
  state = { query: "", area: "" };
  mapAdapter = null;
  controller = new LocatorController(null, showDetails);
  refreshList();
  if (!MAPBOX_TOKEN) return;
  const container = root.querySelector("#locatorMap");
  if (!container) return;
  try {
    controller = new LocatorController(await initMap(container), showDetails);
    refreshList();
    geocodeMissing();
  } catch {
    const slot = root.querySelector('[data-slot="center-map"]');
    if (slot) slot.innerHTML = notice("info", "The map could not be loaded. The directory below still works.");
  }
}

export const locatorPages = {
  "business-centers": { title: "Meralco Business Centers", subtitle: "Help & Support", render: centersPage, load: loadCenters },
};

export const locatorActions = {
  "center-select"(button) {
    controller?.select(button.dataset.id);
  },
};

export function handleLocatorInput(element) {
  const key = element.dataset.locator === "area" ? "area" : "query";
  // The search box fires "change" on blur after "input" already applied the value. Re-rendering
  // again would replace the list between mousedown and mouseup and swallow the user's click.
  if (state[key] === element.value) return;
  state[key] = element.value;
  refreshList();
}
