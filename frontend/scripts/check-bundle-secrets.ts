// Usage: node scripts/check-bundle-secrets.ts   (after `vite build`)
import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadEnv } from 'vite'
import { scanDir, secretValues } from './bundleSecrets.ts'

const root = path.resolve(import.meta.dirname, '..', '..')
const dist = path.resolve(import.meta.dirname, '..', 'dist')
if (!existsSync(dist)) {
  console.error('dist/ not found — run `npm run build` first.')
  process.exit(2)
}
const env = { ...loadEnv('production', root, ''), ...process.env } as Record<string, string | undefined>
const findings = scanDir(dist, env)
console.log(`[secret scan] checked dist/ against ${secretValues(env).length} configured server secret value(s) plus name/pattern rules.`)
if (findings.length) {
  for (const f of findings) console.error(`[secret scan] LEAK: ${f.kind} in ${f.file}`)
  process.exit(1)
}
console.log('[secret scan] OK — no server secrets in the frontend bundle.')
