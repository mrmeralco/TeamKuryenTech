import { beforeEach, describe, expect, it } from 'vitest'
import { LOCAL_KEY, LocalRepo, migrate } from './localRepo'
import type { Appliance } from '../types'

const fan: Appliance = {
  id: 'a1', name: 'Fan', type: 'fan', wattage: 65, quantity: 1, hoursPerDay: 8, daysPerPeriod: 30, notes: '', confirmed: true, createdAt: 'x', updatedAt: 'x',
}

describe('LocalRepo (fallback storage)', () => {
  beforeEach(() => localStorage.clear())

  it('persists across instances (survives refresh) and updates instead of duplicating', async () => {
    const r1 = new LocalRepo()
    await r1.put('appliances', fan)
    await r1.put('appliances', { ...fan, hoursPerDay: 6 })
    const r2 = new LocalRepo()
    let items: Appliance[] = []
    r2.subscribe('appliances', (x) => (items = x))
    expect(items).toHaveLength(1)
    expect(items[0].hoursPerDay).toBe(6)
    expect(r2.userId).toBe(r1.userId)
  })

  it('notifies subscribers on delete and clearAll', async () => {
    const r = new LocalRepo()
    const seen: number[] = []
    r.subscribe('appliances', (x) => seen.push(x.length))
    await r.put('appliances', fan)
    await r.remove('appliances', 'a1')
    await r.put('appliances', fan)
    await r.clearAll()
    expect(seen).toEqual([0, 1, 0, 1, 0])
  })

  it('recovers from corrupted storage and migrates unknown shapes', () => {
    localStorage.setItem(LOCAL_KEY, '{not json')
    expect(() => new LocalRepo()).not.toThrow()
    const m = migrate({ version: 0, bills: { x: 1 } })
    expect(m.version).toBe(2)
    expect(m.appliances).toEqual({})
  })

  it('migrates v1 data to v2 without losing records', () => {
    const v1 = { version: 1, userId: 'local-abc', bills: { b1: { id: 'b1' } }, appliances: { a1: fan }, plans: {} }
    localStorage.setItem(LOCAL_KEY, JSON.stringify(v1))
    const r = new LocalRepo()
    expect(r.userId).toBe('local-abc')
    let items: Appliance[] = []
    r.subscribe('appliances', (x) => (items = x))
    expect(items).toEqual([fan])
    const saved = JSON.parse(localStorage.getItem(LOCAL_KEY)!)
    expect(saved.version).toBe(2)
    expect(saved.profile).toEqual({})
  })

  it('rolls back the in-memory change when storage write fails', async () => {
    const store: Record<string, string> = {}
    const failing = {
      getItem: () => null,
      setItem(k: string, v: string) {
        if (v.includes('"a1"')) throw new DOMException('quota', 'QuotaExceededError')
        store[k] = v
      },
    } as unknown as Storage
    const r = new LocalRepo(failing)
    await expect(r.put('appliances', fan)).rejects.toThrow()
    let items: Appliance[] = [fan]
    r.subscribe('appliances', (x) => (items = x))
    expect(items).toEqual([])
  })
})
