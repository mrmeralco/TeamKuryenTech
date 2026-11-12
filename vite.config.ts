import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  plugins: [
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
        start_url: "/",
        icons: [
          { src: "/pwa-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
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
    proxy: { "/api": process.env.SMARTWATTS_API_PROXY ?? "http://127.0.0.1:8000" },
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
