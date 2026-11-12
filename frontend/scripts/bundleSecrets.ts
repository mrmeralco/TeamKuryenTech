/**
 * Scans built frontend assets for server secrets. Never prints secret values — only the kind of
 * finding and the file it was found in.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { isUnset, SERVER_ONLY_KEYS } from '../src/lib/envRules.ts'

export interface Finding {
  file: string
  kind: string
}

const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)/i

/** Values that must never appear in the bundle: server-only env vars that look like secrets. */
export function secretValues(env: Record<string, string | undefined>): Array<{ name: string; value: string }> {
  return Object.entries(env)
    .filter(([k, v]) => !k.startsWith('VITE_') && (SERVER_ONLY_KEYS.includes(k as never) || SECRET_NAME.test(k)) && !isUnset(v) && v!.trim().length >= 8)
    .map(([name, v]) => ({ name, value: v!.trim() }))
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.(js|mjs|css|html|json|webmanifest|map|txt)$/.test(f) ? [p] : []
  })
}

export function scanDir(dir: string, env: Record<string, string | undefined>): Finding[] {
  const values = secretValues(env)
  const allowedGoogleKey = isUnset(env.VITE_FIREBASE_API_KEY) ? null : env.VITE_FIREBASE_API_KEY!.trim()
  const findings: Finding[] = []
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf8')
    const rel = path.relative(dir, file)
    for (const k of SERVER_ONLY_KEYS) if (text.includes(k)) findings.push({ file: rel, kind: `server-only variable name ${k}` })
    for (const { name, value } of values) if (text.includes(value)) findings.push({ file: rel, kind: `value of ${name}` })
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) findings.push({ file: rel, kind: 'private key block' })
    // Google API keys: only the public Firebase web key may appear in the bundle.
    for (const m of text.matchAll(/AIza[0-9A-Za-z_-]{35}/g)) if (m[0] !== allowedGoogleKey) findings.push({ file: rel, kind: 'unexpected Google API key' })
  }
  return findings
}
