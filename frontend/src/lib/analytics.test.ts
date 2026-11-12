import { describe, expect, it } from 'vitest'
import { aggregateBills, bucketKey, changeVsPrevious, seasonOf } from './analytics'
import type { Bill } from './types'

const b = (periodEnd: string, kwh: number, amountPhp: number): Bill => ({
  id: periodEnd, periodStart: periodEnd, periodEnd, kwh, amountPhp, rate: null, charges: [], source: 'manual', createdAt: '', updatedAt: '',
})

describe('analytics aggregation (step 17)', () => {
  const bills = [b('2026-01-14', 200, 2500), b('2026-02-14', 220, 2700), b('2026-04-14', 300, 3800), b('2025-12-14', 180, 2200)]
  it('monthly, quarterly, yearly buckets', () => {
    expect(aggregateBills(bills, 'monthly').map((x) => x.key)).toEqual(['2025-12', '2026-01', '2026-02', '2026-04'])
    expect(aggregateBills(bills, 'quarterly')).toEqual([
      { key: '2025-Q4', label: '2025-Q4', kwh: 180, amountPhp: 2200, bills: 1 },
      { key: '2026-Q1', label: '2026-Q1', kwh: 420, amountPhp: 5200, bills: 2 },
      { key: '2026-Q2', label: '2026-Q2', kwh: 300, amountPhp: 3800, bills: 1 },
    ])
    expect(aggregateBills(bills, 'yearly').map((x) => [x.key, x.kwh])).toEqual([['2025', 180], ['2026', 720]])
  })
  it('seasonal buckets keep Dec with the following cool-dry season', () => {
    expect(seasonOf(4)).toBe('hot_dry')
    expect(seasonOf(8)).toBe('rainy')
    expect(seasonOf(1)).toBe('cool_dry')
    expect(bucketKey('2025-12-14', 'seasonal')).toBe('2026-cool_dry')
    expect(aggregateBills(bills, 'seasonal').find((x) => x.key === '2026-cool_dry')!.bills).toBe(3)
  })
  it('change vs previous needs two bills', () => {
    expect(changeVsPrevious([bills[0]])).toBeNull()
    expect(changeVsPrevious(bills)).toEqual({ kwh: 80, amountPhp: 1100, pctKwh: 36.4 })
  })
  it('empty input gives no buckets (no fabricated trend)', () => {
    expect(aggregateBills([], 'monthly')).toEqual([])
  })
})
