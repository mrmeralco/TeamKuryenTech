import { describe, expect, it } from 'vitest'
import spec from '../../../spec/calc-cases.json'
import { CalcError, compare, costPhp, energyKwh, round2 } from './energy'

describe('shared calculation spec (same file the backend tests use)', () => {
  it.each(spec.energyCases)('$name', (c) => {
    expect(energyKwh(c.input)).toBe(c.kwh)
  })
  it.each(spec.scenarioCases)('$name', (c) => {
    const r = compare(c.baseline, c.scenario, c.rate)
    expect(r).toEqual({
      baselineKwh: c.baselineKwh, scenarioKwh: c.scenarioKwh, deltaKwh: c.deltaKwh, savedKwh: c.savedKwh, savedPhp: c.savedPhp, direction: c.direction,
    })
  })
  it.each(spec.invalidInputs)('rejects $name', (c) => {
    expect(() => energyKwh(c.input)).toThrow(CalcError)
  })
  it.each(spec.invalidRates)('rejects rate %s', (rate) => {
    const u = { wattage: 65, hoursPerDay: 8, days: 30, quantity: 1 }
    expect(() => compare(u, u, rate)).toThrow(CalcError)
  })
})

describe('energy helpers', () => {
  it('rejects NaN and Infinity', () => {
    expect(() => energyKwh({ wattage: NaN, hoursPerDay: 8, days: 30, quantity: 1 })).toThrow(CalcError)
    expect(() => energyKwh({ wattage: 65, hoursPerDay: Infinity, days: 30, quantity: 1 })).toThrow(CalcError)
  })
  it('rounds half away from zero without binary noise', () => {
    expect(round2(0.125)).toBe(0.13)
    expect(round2(-0.125)).toBe(-0.13)
    expect(round2(15.6 - 11.7)).toBe(3.9)
    expect(round2(-0)).toBe(0)
  })
  it('cost uses unrounded kWh and returns null without a rate', () => {
    expect(costPhp({ wattage: 65, hoursPerDay: 8, days: 30, quantity: 1 }, 12.43)).toBe(193.91)
    expect(costPhp({ wattage: 65, hoursPerDay: 8, days: 30, quantity: 1 }, null)).toBeNull()
  })
})
