import type { Rate } from './types'

/**
 * Reference figure cited in the SmartWatts/Kuryentech proposal: the Philippine average
 * electricity rate reported by the DOE for June 2026 (Philippine Daily Inquirer, July 2026).
 * It is NOT a specific Meralco rate for the user's billing month, so it is only used when
 * the user explicitly selects it, and it is always labeled.
 */
export const REFERENCE_RATE: Rate = {
  valuePhpPerKwh: 12.43,
  source: 'reference',
  label: 'PH average rate reported by DOE, June 2026 (Inquirer, Jul 2026) — not your exact Meralco rate',
  month: '2026-06',
}

export function billDerivedRate(amountPhp: number, kwh: number, periodEnd: string): Rate | null {
  if (!(kwh > 0) || !(amountPhp > 0)) return null
  const value = Math.round((amountPhp / kwh) * 10000) / 10000
  if (value > 100) return null
  return {
    valuePhpPerKwh: value,
    source: 'bill_derived',
    label: 'Effective rate from your bill (total amount ÷ kWh, includes all charges)',
    month: periodEnd.slice(0, 7),
  }
}
