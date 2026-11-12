import type { Lang } from '@/i18n'

const locale = (lang: Lang) => (lang === 'fil' ? 'fil-PH' : 'en-PH')

export function php(value: number, lang: Lang = 'en'): string {
  return new Intl.NumberFormat(locale(lang), { style: 'currency', currency: 'PHP', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
}

export function kwh(value: number, lang: Lang = 'en'): string {
  return `${new Intl.NumberFormat(locale(lang), { maximumFractionDigits: 2 }).format(value)} kWh`
}

export function num(value: number, lang: Lang = 'en'): string {
  return new Intl.NumberFormat(locale(lang), { maximumFractionDigits: 2 }).format(value)
}

export function dateLabel(iso: string, lang: Lang = 'en'): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m) return iso
  return new Intl.DateTimeFormat(locale(lang), { year: 'numeric', month: 'short', day: d ? 'numeric' : undefined, timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d || 1)),
  )
}

export function monthLabel(ym: string, lang: Lang = 'en'): string {
  const [y, m] = ym.split('-').map(Number)
  return new Intl.DateTimeFormat(locale(lang), { year: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)))
}

/** Parse user-typed numbers safely: accepts "3,500.50", " 280 ", rejects "", "abc", "1e400". */
export function parseNumberInput(raw: string): number | null {
  const cleaned = raw.trim().replace(/[₱,\s]/g, '').replace(/^php/i, '')
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}
