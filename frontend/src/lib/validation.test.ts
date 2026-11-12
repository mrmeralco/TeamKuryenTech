import { describe, expect, it } from 'vitest'
import { parseNumberInput } from './format'
import { REFERENCE_RATE } from './rates'
import { emptyBillDraft, validateAppliance, validateBill, type ApplianceDraft } from './validation'

const bill = (p: Partial<ReturnType<typeof emptyBillDraft>> = {}) => ({
  ...emptyBillDraft('manual'), periodStart: '2026-09-15', periodEnd: '2026-10-14', kwh: '280', amountPhp: '3,500.00', ...p,
})

describe('bill validation (steps 4–5)', () => {
  it('accepts a valid bill and derives the effective rate from the bill', () => {
    const { value, errors } = validateBill(bill())
    expect(errors).toEqual({})
    expect(value!.amountPhp).toBe(3500)
    expect(value!.rate).toMatchObject({ source: 'bill_derived', valuePhpPerKwh: 12.5, month: '2026-10' })
  })
  it('requires fields', () => {
    const { errors } = validateBill(emptyBillDraft())
    expect(errors).toMatchObject({ periodStart: 'err.required', periodEnd: 'err.required', kwh: 'err.required', amountPhp: 'err.required' })
  })
  it('rejects negative amounts and kWh, invalid and reversed periods', () => {
    expect(validateBill(bill({ kwh: '-1' })).errors.kwh).toBe('err.negative')
    expect(validateBill(bill({ amountPhp: '-5' })).errors.amountPhp).toBe('err.negative')
    expect(validateBill(bill({ kwh: 'abc' })).errors.kwh).toBe('err.number')
    expect(validateBill(bill({ periodEnd: '2026-09-01' })).errors.periodEnd).toBe('err.periodOrder')
    expect(validateBill(bill({ periodEnd: '2026-12-31' })).errors.periodEnd).toBe('err.periodLength')
    expect(validateBill(bill({ periodStart: '2026-02-30' })).errors.periodStart).toBe('err.date')
  })
  it('accepts zero consumption but then needs another rate option', () => {
    expect(validateBill(bill({ kwh: '0', amountPhp: '45' })).errors).toEqual({ rateChoice: 'err.rateNeedsKwh' })
    const ok = validateBill(bill({ kwh: '0', amountPhp: '45', rateChoice: 'none' }))
    expect(ok.value).toMatchObject({ kwh: 0, rate: null })
  })
  it('user-entered rate must be in range with a month', () => {
    expect(validateBill(bill({ rateChoice: 'user_entered', rateValue: '0', rateMonth: '2026-10' })).errors.rateValue).toBe('err.rateRange')
    expect(validateBill(bill({ rateChoice: 'user_entered', rateValue: '12', rateMonth: '' })).errors.rateMonth).toBe('err.month')
    expect(validateBill(bill({ rateChoice: 'user_entered', rateValue: '12.1', rateMonth: '2026-10' })).value!.rate).toMatchObject({ valuePhpPerKwh: 12.1, source: 'user_entered' })
  })
  it('reference rate is labeled and never silently applied', () => {
    expect(validateBill(bill({ rateChoice: 'reference' })).value!.rate).toBe(REFERENCE_RATE)
    expect(REFERENCE_RATE.label).toMatch(/not your exact/i)
    expect(validateBill(bill({ rateChoice: 'none' })).value!.rate).toBeNull()
  })
})

const appl = (p: Partial<ApplianceDraft> = {}): ApplianceDraft => ({
  name: 'Electric fan', type: 'fan', wattage: '65', quantity: '1', hoursPerDay: '8', daysPerPeriod: '30', notes: '', ...p,
})

describe('appliance validation (steps 8, 10)', () => {
  it('accepts the flowchart fan', () => {
    expect(validateAppliance(appl()).value).toMatchObject({ wattage: 65, quantity: 1, hoursPerDay: 8, daysPerPeriod: 30 })
  })
  it.each([
    [{ wattage: '0' }, 'wattage', 'err.positive'],
    [{ wattage: '-5' }, 'wattage', 'err.positive'],
    [{ quantity: '1.5' }, 'quantity', 'err.wholePositive'],
    [{ quantity: '0' }, 'quantity', 'err.wholePositive'],
    [{ hoursPerDay: '25' }, 'hoursPerDay', 'err.hours'],
    [{ daysPerPeriod: '0' }, 'daysPerPeriod', 'err.days'],
    [{ name: '  ' }, 'name', 'err.required'],
  ] as const)('%o -> %s %s', (patch, field, err) => {
    expect(validateAppliance(appl(patch)).errors[field]).toBe(err)
  })
  it('limits days to the billing period length', () => {
    expect(validateAppliance(appl({ daysPerPeriod: '31' }), 30).errors.daysPerPeriod).toBe('err.days')
    expect(validateAppliance(appl({ daysPerPeriod: '30' }), 30).value).not.toBeNull()
  })
})

describe('number input parsing', () => {
  it.each([
    ['3,500.50', 3500.5], [' 280 ', 280], ['₱1,234', 1234], ['0', 0], ['.5', 0.5],
    ['', null], ['abc', null], ['1e400', null], ['12abc', null],
  ])('%s -> %s', (raw, out) => expect(parseNumberInput(raw)).toBe(out))
})
