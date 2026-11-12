import { monthOf } from './dates'
import type { Bill } from './types'

export type Granularity = 'monthly' | 'quarterly' | 'yearly' | 'seasonal'

export interface Bucket {
  key: string
  label: string
  kwh: number
  amountPhp: number
  bills: number
}

/**
 * Bills are assigned to the month their billing period ENDS in (how Meralco labels a bill).
 * Seasons use the PAGASA calendar convention: hot dry (Mar–May), rainy (Jun–Nov), cool dry (Dec–Feb).
 * This is a calendar grouping, not weather data.
 */
export function seasonOf(month: number): 'hot_dry' | 'rainy' | 'cool_dry' {
  if (month >= 3 && month <= 5) return 'hot_dry'
  if (month >= 6 && month <= 11) return 'rainy'
  return 'cool_dry'
}

export function bucketKey(periodEnd: string, g: Granularity): string {
  const ym = monthOf(periodEnd)
  const [y, m] = ym.split('-').map(Number)
  switch (g) {
    case 'monthly':
      return ym
    case 'quarterly':
      return `${y}-Q${Math.ceil(m / 3)}`
    case 'yearly':
      return String(y)
    case 'seasonal': {
      const s = seasonOf(m)
      // Dec belongs to the cool-dry season that continues into the next year.
      const seasonYear = s === 'cool_dry' && m === 12 ? y + 1 : y
      return `${seasonYear}-${s}`
    }
  }
}

export function aggregateBills(bills: Bill[], g: Granularity): Bucket[] {
  const map = new Map<string, Bucket>()
  for (const b of bills) {
    const key = bucketKey(b.periodEnd, g)
    const cur = map.get(key) ?? { key, label: key, kwh: 0, amountPhp: 0, bills: 0 }
    cur.kwh = Math.round((cur.kwh + b.kwh) * 100) / 100
    cur.amountPhp = Math.round((cur.amountPhp + b.amountPhp) * 100) / 100
    cur.bills += 1
    map.set(key, cur)
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key))
}

export function sortBills(bills: Bill[]): Bill[] {
  return [...bills].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
}

export function latestBill(bills: Bill[]): Bill | null {
  const s = sortBills(bills)
  return s.length ? s[s.length - 1] : null
}

/** Change between the latest bill and the previous one; null with fewer than two bills. */
export function changeVsPrevious(bills: Bill[]) {
  const s = sortBills(bills)
  if (s.length < 2) return null
  const cur = s[s.length - 1]
  const prev = s[s.length - 2]
  return {
    kwh: Math.round((cur.kwh - prev.kwh) * 100) / 100,
    amountPhp: Math.round((cur.amountPhp - prev.amountPhp) * 100) / 100,
    pctKwh: prev.kwh > 0 ? Math.round(((cur.kwh - prev.kwh) / prev.kwh) * 1000) / 10 : null,
  }
}
