import { MAX_DAYS, MAX_RATE } from './energy'
import { parseIsoDate, periodDays } from './dates'
import { parseNumberInput } from './format'
import { billDerivedRate, REFERENCE_RATE } from './rates'
import { APPLIANCE_TYPES, type Appliance, type ApplianceType, type Bill, type BillCharge, type Rate } from './types'
import type { TKey } from '@/i18n'

export type RateChoice = 'bill_derived' | 'user_entered' | 'reference' | 'none'

export interface BillDraft {
  id?: string
  periodStart: string
  periodEnd: string
  kwh: string
  amountPhp: string
  rateChoice: RateChoice
  rateValue: string
  rateMonth: string
  charges: BillCharge[]
  source: 'ocr' | 'manual'
  /** OCR metadata: fields the photo did not yield, and whether the read was low-confidence. */
  ocrMissing?: string[]
  ocrLowConfidence?: boolean
}

export const emptyBillDraft = (source: 'ocr' | 'manual' = 'manual'): BillDraft => ({
  periodStart: '', periodEnd: '', kwh: '', amountPhp: '', rateChoice: 'bill_derived', rateValue: '', rateMonth: '', charges: [], source,
})

export type FieldErrors<K extends string> = Partial<Record<K, TKey>>

export type BillField = 'periodStart' | 'periodEnd' | 'kwh' | 'amountPhp' | 'rateValue' | 'rateMonth' | 'rateChoice'
export const BILL_FIELD_ORDER: BillField[] = ['periodStart', 'periodEnd', 'kwh', 'amountPhp', 'rateChoice', 'rateValue', 'rateMonth']

export type ValidBill = Pick<Bill, 'periodStart' | 'periodEnd' | 'kwh' | 'amountPhp' | 'rate' | 'charges' | 'source'>

export function validateBill(d: BillDraft): { errors: FieldErrors<BillField>; value: ValidBill | null } {
  const errors: FieldErrors<BillField> = {}
  if (!d.periodStart) errors.periodStart = 'err.required'
  else if (!parseIsoDate(d.periodStart)) errors.periodStart = 'err.date'
  if (!d.periodEnd) errors.periodEnd = 'err.required'
  else if (!parseIsoDate(d.periodEnd)) errors.periodEnd = 'err.date'
  if (!errors.periodStart && !errors.periodEnd) {
    const days = periodDays(d.periodStart, d.periodEnd)!
    if (days < 2) errors.periodEnd = 'err.periodOrder'
    else if (days > MAX_DAYS) errors.periodEnd = 'err.periodLength'
  }

  const kwh = parseNumberInput(d.kwh)
  if (d.kwh.trim() === '') errors.kwh = 'err.required'
  else if (kwh === null) errors.kwh = 'err.number'
  else if (kwh < 0) errors.kwh = 'err.negative'
  else if (kwh > 100000) errors.kwh = 'err.tooLarge'

  const amount = parseNumberInput(d.amountPhp)
  if (d.amountPhp.trim() === '') errors.amountPhp = 'err.required'
  else if (amount === null) errors.amountPhp = 'err.number'
  else if (amount < 0) errors.amountPhp = 'err.negative'
  else if (amount > 10_000_000) errors.amountPhp = 'err.tooLarge'

  let rate: Rate | null = null
  if (d.rateChoice === 'bill_derived') {
    if (kwh !== null && amount !== null && !errors.periodEnd && !errors.periodStart) {
      rate = billDerivedRate(amount, kwh, d.periodEnd)
      if (!rate) errors.rateChoice = 'err.rateNeedsKwh'
    }
  } else if (d.rateChoice === 'user_entered') {
    const v = parseNumberInput(d.rateValue)
    if (d.rateValue.trim() === '') errors.rateValue = 'err.required'
    else if (v === null) errors.rateValue = 'err.number'
    else if (v <= 0 || v > MAX_RATE) errors.rateValue = 'err.rateRange'
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(d.rateMonth)) errors.rateMonth = 'err.month'
    if (v !== null && !errors.rateValue && !errors.rateMonth)
      rate = { valuePhpPerKwh: v, source: 'user_entered', label: 'Rate you entered', month: d.rateMonth }
  } else if (d.rateChoice === 'reference') {
    rate = REFERENCE_RATE
  }

  const ok = Object.keys(errors).length === 0
  return {
    errors,
    value: ok
      ? { periodStart: d.periodStart, periodEnd: d.periodEnd, kwh: kwh!, amountPhp: amount!, rate, charges: d.charges, source: d.source }
      : null,
  }
}

export interface ApplianceDraft {
  id?: string
  name: string
  type: ApplianceType
  wattage: string
  quantity: string
  hoursPerDay: string
  daysPerPeriod: string
  notes: string
}

export type ApplianceField = 'name' | 'type' | 'wattage' | 'quantity' | 'hoursPerDay' | 'daysPerPeriod' | 'notes'
export const APPLIANCE_FIELD_ORDER: ApplianceField[] = ['type', 'name', 'wattage', 'quantity', 'hoursPerDay', 'daysPerPeriod', 'notes']

export type ValidAppliance = Pick<Appliance, 'name' | 'type' | 'wattage' | 'quantity' | 'hoursPerDay' | 'daysPerPeriod' | 'notes'>

export const draftFromAppliance = (a: Appliance): ApplianceDraft => ({
  id: a.id, name: a.name, type: a.type, wattage: String(a.wattage), quantity: String(a.quantity),
  hoursPerDay: String(a.hoursPerDay), daysPerPeriod: String(a.daysPerPeriod), notes: a.notes,
})

export function validateAppliance(d: ApplianceDraft, maxDays: number = MAX_DAYS): { errors: FieldErrors<ApplianceField>; value: ValidAppliance | null } {
  const errors: FieldErrors<ApplianceField> = {}
  const name = d.name.trim()
  if (!name) errors.name = 'err.required'
  else if (name.length > 60) errors.name = 'err.tooLong'
  if (!APPLIANCE_TYPES.includes(d.type)) errors.type = 'err.required'

  const w = parseNumberInput(d.wattage)
  if (d.wattage.trim() === '') errors.wattage = 'err.required'
  else if (w === null) errors.wattage = 'err.number'
  else if (w <= 0) errors.wattage = 'err.positive'
  else if (w > 10000) errors.wattage = 'err.tooLarge'

  const q = parseNumberInput(d.quantity)
  if (d.quantity.trim() === '') errors.quantity = 'err.required'
  else if (q === null || !Number.isInteger(q) || q < 1) errors.quantity = 'err.wholePositive'
  else if (q > 100) errors.quantity = 'err.tooLarge'

  const h = parseNumberInput(d.hoursPerDay)
  if (d.hoursPerDay.trim() === '') errors.hoursPerDay = 'err.required'
  else if (h === null) errors.hoursPerDay = 'err.number'
  else if (h < 0 || h > 24) errors.hoursPerDay = 'err.hours'

  const days = parseNumberInput(d.daysPerPeriod)
  if (d.daysPerPeriod.trim() === '') errors.daysPerPeriod = 'err.required'
  else if (days === null) errors.daysPerPeriod = 'err.number'
  else if (days < 1 || days > maxDays) errors.daysPerPeriod = 'err.days'

  if (d.notes.length > 200) errors.notes = 'err.tooLong'

  const ok = Object.keys(errors).length === 0
  return {
    errors,
    value: ok ? { name, type: d.type, wattage: w!, quantity: q!, hoursPerDay: h!, daysPerPeriod: days!, notes: d.notes.trim() } : null,
  }
}

/** Typical rated wattages, shown only as a starting suggestion the user must check against the label. */
export const TYPICAL_WATTAGE: Record<ApplianceType, number | null> = {
  fan: 65, aircon: 1000, refrigerator: 150, tv: 100, washing_machine: 500, rice_cooker: 700, kettle: 1500, computer: 150, lighting: 10, other: null,
}

/** Appliances whose real draw varies a lot from the rated wattage (compressors, inverters, thermostats). */
export const VARIABLE_POWER: ReadonlySet<ApplianceType> = new Set(['aircon', 'refrigerator', 'washing_machine', 'rice_cooker', 'kettle'])

export function validateStoredAppliance(a: Appliance, maxDays: number = MAX_DAYS) {
  return validateAppliance(
    { name: a.name, type: a.type, wattage: String(a.wattage), quantity: String(a.quantity), hoursPerDay: String(a.hoursPerDay), daysPerPeriod: String(a.daysPerPeriod), notes: a.notes },
    maxDays,
  )
}
