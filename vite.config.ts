import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import type { Plugin } from "vite";

/**
 * Clean URLs:
 *   /                 -> landing/index.html      (public landing page)
 *   /login            -> landing/login.html
 *   /register         -> landing/register.html
 *   /forgot-password  -> landing/forgot-password.html
 *   /dashboard        -> index.html              (the dashboard)
 * Old /landing/*.html URLs redirect to the clean ones.
 */
const LANDING_PAGES: Record<string, string> = {
  "/": "/landing/index.html",
  "/index.html": "/landing/index.html",
  "/login": "/landing/login.html",
  "/register": "/landing/register.html",
  "/forgot-password": "/landing/forgot-password.html",
  "/reset-password": "/landing/reset-password.html",
};
const LEGACY_REDIRECTS: Record<string, string> = {
  "/landing": "/",
  "/landing/": "/",
  "/landing/index.html": "/",
  "/landing/login.html": "/login",
  "/landing/register.html": "/register",
  "/landing/forgot-password.html": "/forgot-password",
  "/landing/reset-password.html": "/reset-password",
};

function landingRoutes(): Plugin {
  const handler = (req: { url?: string }, res: { statusCode: number; setHeader(k: string, v: string): void; end(): void }, next: () => void) => {
    const [rawPath, query = ""] = (req.url ?? "/").split("?");
    const qs = query ? `?${query}` : "";
    const path = rawPath.length > 1 && rawPath.endsWith("/") && rawPath !== "/landing/" && rawPath !== "/dashboard/" ? rawPath.slice(0, -1) : rawPath;
    if (LEGACY_REDIRECTS[path]) {
      res.statusCode = 301;
      res.setHeader("Location", LEGACY_REDIRECTS[path] + qs);
      return res.end();
    }
    if (LANDING_PAGES[path]) {
      req.url = LANDING_PAGES[path] + qs;
      return next();
    }
    if (path === "/nfc" || path.startsWith("/nfc/")) {
      req.url = `/nfc.html${qs}`;
      return next();
    }
    if (path === "/dashboard" || path === "/dashboard/") {
      if (path.endsWith("/")) {
        // Keep the URL slash-less so the dashboard's relative CSS paths resolve from "/".
        res.statusCode = 301;
        res.setHeader("Location", `/dashboard${qs}`);
        return res.end();
      }
      req.url = `/index.html${qs}`;
    }
    next();
  };
  return {
    name: "smartwatts-landing-routes",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

export default defineConfig({
  base: "./",
  plugins: [
    landingRoutes(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [],
      manifest: {
        name: "SmartWatts",
        short_name: "SmartWatts",
        description: "Monitor and understand your household electricity use.",
        theme_color: "#fffaf2",
        background_color: "#fffaf2",
        display: "standalone",
        start_url: "/dashboard",
        icons: [
          { src: "/pwa-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//, /^\/landing\//, /^\/$/, /^\/(login|register|forgot-password|reset-password)\/?$/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: "CacheFirst",
            options: { cacheName: "google-fonts", expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 } },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      "/api": {
        target: process.env.SMARTWATTS_API_PROXY ?? "http://127.0.0.1:8000",
        configure(proxy) {
          proxy.on("error", (_err, _req, res) => {
            if ("writeHead" in res && !res.headersSent) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ detail: "SmartWatts API backend is not reachable. Please ensure FastAPI is running on 127.0.0.1:8000." }));
            }
          });
        },
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/tesseract.js")) return "ocr";
          if (id.includes("node_modules/recharts") || id.includes("node_modules/victory-vendor")) return "charts";
          if (id.includes("node_modules/firebase") || id.includes("node_modules/@firebase")) return "firebase";
        },
      },
    },
  },
});
