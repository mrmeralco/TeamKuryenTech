/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'
import { isUnset, validateClientEnv } from './src/lib/envRules'

/** Single source of truth: the repository-root .env (one level above frontend/). */
export const ENV_DIR = path.resolve(import.meta.dirname, '..')

/** Fails dev/build on invalid config; warns (never fails) when Firebase is absent so the local demo keeps working. */
function validateEnv(env: Record<string, string>): Plugin {
  return {
    name: 'smartwatts-validate-env',
    configResolved(config) {
      const report = validateClientEnv(env)
      for (const w of report.warnings) config.logger.warn(`[smartwatts env] ${w}`)
      if (report.errors.length) throw new Error(`[smartwatts env] Invalid configuration in ${path.join(ENV_DIR, '.env')}:\n- ${report.errors.join('\n- ')}`)
      config.logger.info(`[smartwatts env] storage mode: ${report.storageMode}`)
    },
  }
}

export default defineConfig(({ mode }) => {
  // Every variable (prefix '') is visible here in Node only; the client bundle still receives only VITE_*.
  const env = loadEnv(mode, ENV_DIR, '')
  const apiTarget = isUnset(env.SMARTWATTS_API_TARGET) ? 'http://127.0.0.1:8000' : env.SMARTWATTS_API_TARGET
  const viteEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('VITE_')))
  return {
  envDir: ENV_DIR,
  plugins: [
    validateEnv(viteEnv),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'SmartWatts — Household Electricity Savings',
        short_name: 'SmartWatts',
        description: 'Estimate and plan electricity savings for Filipino households.',
        theme_color: '#0f766e',
        background_color: '#f8fafc',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: { proxy: { '/api': { target: apiTarget, changeOrigin: false } } },
  preview: { proxy: { '/api': { target: apiTarget, changeOrigin: false } } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
  },
  }
})
