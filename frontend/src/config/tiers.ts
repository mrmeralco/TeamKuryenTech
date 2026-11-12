import type { TKey } from '@/i18n'

/**
 * Proposed customer tiers (flowchart step 19). Kept as configuration so the business model can change
 * without code changes. Prices are intentionally absent: none have been decided.
 */
export interface TierConfig {
  id: string
  title: TKey
  body: TKey
  available: boolean
  priceLabel: string | null
}

export const TIERS: TierConfig[] = [
  { id: 'household', title: 'more.tier1', body: 'more.tier1.body', available: true, priceLabel: null },
  { id: 'tenant-landlord', title: 'more.tier2', body: 'more.tier2.body', available: false, priceLabel: null },
  { id: 'business', title: 'more.tier3', body: 'more.tier3.body', available: false, priceLabel: null },
  { id: 'weather', title: 'more.weather', body: 'more.weather.body', available: false, priceLabel: null },
]
