import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { en, type TKey } from './en'
import { fil } from './fil'

export type { TKey }
export type Lang = 'en' | 'fil'
export const LANG_KEY = 'smartwatts:lang'

/** Keys intentionally identical in both languages (names, sample questions shown as-typed). */
export const SAME_IN_ALL_LANGUAGES: TKey[] = ['app.name', 'lang.en', 'lang.fil', 'adv.suggest1', 'adv.suggest2', 'adv.suggest3', 'adv.suggest4']

const dictionaries: Record<Lang, Partial<Record<TKey, string>>> = { en, fil }

export function translate(lang: Lang, key: TKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[lang][key] ?? en[key] ?? key
  return vars ? template.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`)) : template
}

export function readStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(LANG_KEY)
    return v === 'en' || v === 'fil' ? v : null
  } catch {
    return null
  }
}

interface I18nValue {
  lang: Lang
  hasChosen: boolean
  setLang: (l: Lang) => void
  t: (key: TKey, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const stored = readStoredLang()
  const [lang, setLangState] = useState<Lang>(stored ?? 'en')
  const [hasChosen, setHasChosen] = useState(stored !== null)

  useEffect(() => {
    document.documentElement.lang = lang === 'fil' ? 'fil' : 'en'
  }, [lang])

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    setHasChosen(true)
    try {
      localStorage.setItem(LANG_KEY, l)
    } catch {
      /* preference just won't persist */
    }
  }, [])

  const t = useCallback((key: TKey, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang])
  const value = useMemo(() => ({ lang, hasChosen, setLang, t }), [lang, hasChosen, setLang, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext)
  if (!v) throw new Error('useI18n must be used inside I18nProvider')
  return v
}
