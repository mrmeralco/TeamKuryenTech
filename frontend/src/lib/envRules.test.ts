import { describe, expect, it } from 'vitest'
import { isUnset, validateClientEnv } from './envRules'
import { firebaseConfigFromEnv } from './storage/firebaseConfig'

const full = {
  VITE_FIREBASE_API_KEY: 'k', VITE_FIREBASE_AUTH_DOMAIN: 'p.firebaseapp.com', VITE_FIREBASE_PROJECT_ID: 'p', VITE_FIREBASE_APP_ID: '1:2:web:3',
}

describe('client env validation', () => {
  it('no Firebase -> local mode with a warning, no error', () => {
    const r = validateClientEnv({})
    expect(r).toMatchObject({ storageMode: 'local', errors: [] })
    expect(r.warnings[0]).toMatch(/local-only mode/)
    expect(firebaseConfigFromEnv({})).toBeNull()
  })
  it('template placeholders count as unset (copied .env.example never pretends to be configured)', () => {
    const tpl = { VITE_FIREBASE_API_KEY: 'replace_with_firebase_web_api_key', VITE_FIREBASE_AUTH_DOMAIN: 'replace_with_project_id.firebaseapp.com', VITE_FIREBASE_PROJECT_ID: 'replace_with_project_id', VITE_FIREBASE_APP_ID: 'replace_with_firebase_web_app_id' }
    expect(validateClientEnv(tpl).storageMode).toBe('local')
    expect(firebaseConfigFromEnv(tpl)).toBeNull()
    expect(isUnset('  ')).toBe(true)
  })
  it('complete config -> firestore mode', () => {
    expect(validateClientEnv(full)).toMatchObject({ storageMode: 'firestore', errors: [] })
    expect(firebaseConfigFromEnv(full)).toEqual({ apiKey: 'k', authDomain: 'p.firebaseapp.com', projectId: 'p', appId: '1:2:web:3' })
  })
  it('partial config is an error naming the missing keys', () => {
    const r = validateClientEnv({ VITE_FIREBASE_API_KEY: 'k' })
    expect(r.errors[0]).toMatch(/Missing: VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_APP_ID/)
  })
  it('rejects malformed auth domain and API base URL', () => {
    expect(validateClientEnv({ ...full, VITE_FIREBASE_AUTH_DOMAIN: 'https://p.firebaseapp.com' }).errors[0]).toMatch(/bare host name/)
    expect(validateClientEnv({ VITE_API_BASE_URL: 'http://localhost:8000' }).errors[0]).toMatch(/must end with \/api/)
    expect(validateClientEnv({ VITE_API_BASE_URL: '/api' }).errors).toEqual([])
    expect(validateClientEnv({ VITE_API_BASE_URL: 'https://api.example.com/api' }).errors).toEqual([])
  })
  it('refuses server secrets exposed through the VITE_ prefix', () => {
    expect(validateClientEnv({ VITE_GEMINI_API_KEY: 'x' }).errors[0]).toMatch(/VITE_GEMINI_API_KEY looks like a server secret/)
  })
})
