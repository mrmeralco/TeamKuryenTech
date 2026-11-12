import type { FirebaseOptions } from 'firebase/app'
import { FIREBASE_KEYS, isUnset } from '../envRules'

/**
 * Firebase web config from VITE_FIREBASE_* (loaded from the repository-root .env via Vite envDir).
 * Returns null — local-only mode — unless every required value is present and not a template placeholder.
 */
export function firebaseConfigFromEnv(env: Record<string, string | undefined> = import.meta.env): FirebaseOptions | null {
  if (FIREBASE_KEYS.some((k) => isUnset(env[k]))) return null
  return {
    apiKey: env.VITE_FIREBASE_API_KEY!.trim(),
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN!.trim(),
    projectId: env.VITE_FIREBASE_PROJECT_ID!.trim(),
    appId: env.VITE_FIREBASE_APP_ID!.trim(),
  }
}
