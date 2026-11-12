/**
 * Deterministic energy calculator (client side). Works offline.
 * Mirrors backend/app/energy.py; both are tested against spec/calc-cases.json.
 *
 * Units: wattage W, hours per day h, days d, rate PHP/kWh.
 * Rounding: 2 decimals, half away from zero, applied only to outputs.
 */
import type { Appliance, CompareResult, Usage } from './types'

export const MAX_DAYS = 45
export const MAX_HOURS = 24
export const MAX_RATE = 100

export class CalcError extends Error {}

export function round2(value: number): number {
  // toPrecision(15) strips binary noise (3.9000000000000004 -> 3.9) before rounding.
  const clean = Number(value.toPrecision(15))
  const sign = clean < 0 ? -1 : 1
  const r = (sign * Math.round(Math.abs(clean) * 100 + 1e-9)) / 100
  return Object.is(r, -0) ? 0 : r
}

function finite(name: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CalcError(`${name} must be a finite number`)
  return v
}

export function validateUsage(u: Usage): void {
  const w = finite('wattage', u.wattage)
  const h = finite('hoursPerDay', u.hoursPerDay)
  const d = finite('days', u.days)
  const q = finite('quantity', u.quantity)
  if (w <= 0) throw new CalcError('wattage must be greater than 0')
  if (h < 0 || h > MAX_HOURS) throw new CalcError('hoursPerDay must be between 0 and 24')
  if (d <= 0 || d > MAX_DAYS) throw new CalcError(`days must be between 1 and ${MAX_DAYS}`)
  if (!Number.isInteger(q) || q < 1) throw new CalcError('quantity must be a positive whole number')
}

export function validateRate(rate: number | null): void {
  if (rate === null) return
  const r = finite('rate', rate)
  if (r <= 0 || r > MAX_RATE) throw new CalcError('rate must be greater than 0 and at most 100 PHP/kWh')
}

export function energyKwhRaw(u: Usage): number {
  validateUsage(u)
  return (u.wattage * u.hoursPerDay * u.days * u.quantity) / 1000
}

export const energyKwh = (u: Usage): number => round2(energyKwhRaw(u))

export function costPhp(u: Usage, rate: number | null): number | null {
  validateRate(rate)
  return rate === null ? null : round2(energyKwhRaw(u) * rate)
}

export function compare(baseline: Usage, scenario: Usage, rate: number | null): CompareResult {
  validateRate(rate)
  const b = energyKwhRaw(baseline)
  const s = energyKwhRaw(scenario)
  let delta = s - b
  let saved = b - s
  let direction: CompareResult['direction']
  if (Math.abs(delta) < 1e-9) {
    direction = 'none'
    delta = 0
    saved = 0
  } else direction = delta > 0 ? 'increase' : 'decrease'
  return {
    baselineKwh: round2(b),
    scenarioKwh: round2(s),
    deltaKwh: round2(delta),
    savedKwh: round2(saved),
    savedPhp: rate === null ? null : round2(saved * rate),
    direction,
  }
}

export const usageOf = (a: Pick<Appliance, 'wattage' | 'hoursPerDay' | 'daysPerPeriod' | 'quantity'>): Usage => ({
  wattage: a.wattage,
  hoursPerDay: a.hoursPerDay,
  days: a.daysPerPeriod,
  quantity: a.quantity,
})

/** Estimated kWh for an appliance, or null when its stored values are invalid. */
export function safeApplianceKwh(a: Appliance): number | null {
  try {
    return energyKwh(usageOf(a))
  } catch {
    return null
  }
}
