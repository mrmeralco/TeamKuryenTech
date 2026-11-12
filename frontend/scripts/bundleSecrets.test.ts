import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanDir, secretValues } from './bundleSecrets'

const FAKE_GEMINI = 'fake-gemini-value-1234567890'
const FAKE_FIREBASE = 'AIza' + 'A'.repeat(35)

function dist(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-dist-'))
  mkdirSync(path.join(dir, 'assets'))
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(dir, f), c)
  return dir
}

describe('bundle secret scanner', () => {
  const env = { GEMINI_API_KEY: FAKE_GEMINI, VITE_FIREBASE_API_KEY: FAKE_FIREBASE, CORS_ORIGINS: 'http://localhost:5173' }

  it('passes a clean bundle that contains only the public Firebase web key', () => {
    expect(scanDir(dist({ 'assets/a.js': `const k="${FAKE_FIREBASE}";fetch("/api/health")` }), env)).toEqual([])
  })
  it('detects a leaked server secret value, the variable name, and stray Google keys — without echoing values', () => {
    const findings = scanDir(dist({ 'assets/a.js': `x="${FAKE_GEMINI}";y="GEMINI_API_KEY";z="AIza${'B'.repeat(35)}"` }), env)
    expect(findings.map((f) => f.kind).sort()).toEqual(['server-only variable name GEMINI_API_KEY', 'unexpected Google API key', 'value of GEMINI_API_KEY'])
    expect(JSON.stringify(findings)).not.toContain(FAKE_GEMINI)
  })
  it('ignores placeholders and public values', () => {
    expect(secretValues({ GEMINI_API_KEY: 'replace_with_server_side_gemini_api_key', CORS_ORIGINS: 'http://x', VITE_FIREBASE_API_KEY: 'abc' })).toEqual([])
  })
})
