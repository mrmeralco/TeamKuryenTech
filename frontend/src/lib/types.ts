export type RateSource = 'bill_derived' | 'user_entered' | 'reference'

/** An electricity rate the user explicitly confirmed, always with its source and month. */
export interface Rate {
  valuePhpPerKwh: number
  source: RateSource
  label: string
  /** YYYY-MM the rate applies to */
  month: string
}

export interface BillCharge {
  key: string
  amountPhp: number
}

export interface Bill {
  id: string
  periodStart: string // YYYY-MM-DD
  periodEnd: string // YYYY-MM-DD
  kwh: number
  amountPhp: number
  rate: Rate | null
  charges: BillCharge[]
  source: 'ocr' | 'manual'
  createdAt: string
  updatedAt: string
}

export const APPLIANCE_TYPES = [
  'fan', 'aircon', 'refrigerator', 'tv', 'washing_machine', 'rice_cooker', 'kettle', 'computer', 'lighting', 'other',
] as const
export type ApplianceType = (typeof APPLIANCE_TYPES)[number]

export interface Appliance {
  id: string
  name: string
  type: ApplianceType
  wattage: number
  quantity: number
  hoursPerDay: number
  daysPerPeriod: number
  notes: string
  /** Set at flowchart step 11 after the user confirms the list is complete and correct. */
  confirmed: boolean
  createdAt: string
  updatedAt: string
}

export interface Usage {
  wattage: number
  hoursPerDay: number
  days: number
  quantity: number
}

export type Direction = 'decrease' | 'increase' | 'none'

export interface CompareResult {
  baselineKwh: number
  scenarioKwh: number
  deltaKwh: number
  savedKwh: number
  savedPhp: number | null
  direction: Direction
}

export interface Plan {
  id: string
  applianceId: string
  applianceName: string
  baseline: Usage
  scenario: Usage
  rate: Rate | null
  result: CompareResult
  goal: string
  createdAt: string
  updatedAt: string
  recalculatedAt: string | null
}

/** One per household. Ownership comes from the storage path (users/{uid}/profile/household), never a client field. */
export interface HouseholdProfile {
  id: 'household'
  language: 'en' | 'fil'
  createdAt: string
  updatedAt: string
}

export type CollectionName = 'bills' | 'appliances' | 'plans' | 'profile'
export interface CollectionMap {
  bills: Bill
  appliances: Appliance
  plans: Plan
  profile: HouseholdProfile
}
