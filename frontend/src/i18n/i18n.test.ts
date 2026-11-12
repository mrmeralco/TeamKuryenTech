import { describe, expect, it } from 'vitest'
import { en, type TKey } from './en'
import { fil } from './fil'
import { SAME_IN_ALL_LANGUAGES, translate } from './index'

describe('translations', () => {
  it('Filipino covers every key except intentional shared ones', () => {
    const missing = (Object.keys(en) as TKey[]).filter((k) => !(k in fil) && !SAME_IN_ALL_LANGUAGES.includes(k))
    expect(missing).toEqual([])
  })
  it('placeholders match between languages', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const k of Object.keys(fil) as TKey[]) expect([k, vars(fil[k]!)]).toEqual([k, vars(en[k])])
  })
  it('falls back to English and interpolates', () => {
    expect(translate('fil', 'lang.en')).toBe('English')
    expect(translate('en', 'appl.estimate', { kwh: '15.6 kWh' })).toBe('Estimated 15.6 kWh per billing period')
  })
})
