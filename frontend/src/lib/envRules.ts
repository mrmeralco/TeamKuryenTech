/**
 * Environment rules shared by the browser code and vite.config.ts (no Node or DOM APIs here).
 *
 * Only VITE_* variables reach the browser bundle. Firebase web config values are public client
 * identifiers; security comes from Firebase Auth + firestore.rules. Server secrets (GEMINI_API_KEY)
 * must never use the VITE_ prefix.
 */

export const FIREBASE_KEYS = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID'] as const

/** Server-only names that must never be exposed through the VITE_ prefix. */
export const SERVER_ONLY_KEYS = ['GEMINI_API_KEY'] as const

type Env = Record<string, string | undefined>

/** Template values like "replace_with_project_id" count as unset, so a copied example never looks configured. */
export function isUnset(v: string | undefined): boolean {
  const s = (v ?? '').trim()
  return s === '' || /^replace[_-]?with/i.test(s) || /^your[_-]/i.test(s) || s === 'changeme'
}

export interface ClientEnvReport {
  storageMode: 'firestore' | 'local'
  errors: string[]
  warnings: string[]
}

export function validateClientEnv(env: Env): ClientEnvReport {
  const errors: string[] = []
  const warnings: string[] = []

  const set = FIREBASE_KEYS.filter((k) => !isUnset(env[k]))
  const missing = FIREBASE_KEYS.filter((k) => isUnset(env[k]))
  let storageMode: ClientEnvReport['storageMode'] = 'local'
  if (set.length === FIREBASE_KEYS.length) storageMode = 'firestore'
  else if (set.length > 0) errors.push(`Firebase config is incomplete. Set all of ${FIREBASE_KEYS.join(', ')} or none. Missing: ${missing.join(', ')}.`)
  else warnings.push('Firebase is not configured (VITE_FIREBASE_* empty): SmartWatts runs in local-only mode; data stays in this browser and is not synced.')

  if (storageMode === 'firestore') {
    const domain = env.VITE_FIREBASE_AUTH_DOMAIN!.trim()
    if (/^https?:\/\//i.test(domain) || domain.includes('/')) errors.push('VITE_FIREBASE_AUTH_DOMAIN must be a bare host name such as my-project.firebaseapp.com (no https:// or path).')
  }

  const base = env.VITE_API_BASE_URL
  if (!isUnset(base)) {
    const b = base!.trim()
    if (!(b.startsWith('/') || /^https?:\/\/[^\s]+$/i.test(b))) errors.push('VITE_API_BASE_URL must be a path like /api or an http(s) URL.')
    else if (!/\/api\/?$/.test(b)) errors.push(`VITE_API_BASE_URL must end with /api (the client calls <base>/health, <base>/ocr/bill…). Got a value that does not.`)
  }

  for (const k of Object.keys(env)) {
    if (k.startsWith('VITE_') && /(GEMINI|SECRET|PRIVATE|PASSWORD|SERVICE_ACCOUNT|TOKEN)/i.test(k))
      errors.push(`${k} looks like a server secret but has the VITE_ prefix, which would embed it in the public browser bundle. Remove the VITE_ prefix and keep it server-side.`)
  }
  return { storageMode, errors, warnings }
}
