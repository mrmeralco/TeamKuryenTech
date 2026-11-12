/**
 * Local-only fallback used when Firebase is not configured. Data stays in this browser
 * (localStorage), survives refresh and works offline, but does not sync anywhere.
 */
import type { CollectionMap, CollectionName } from '../types'
import { COLLECTIONS, type Repo } from './repo'

export const LOCAL_KEY = 'smartwatts:data'
export const SCHEMA_VERSION = 2

interface StoreShape {
  version: number
  userId: string
  bills: Record<string, CollectionMap['bills']>
  appliances: Record<string, CollectionMap['appliances']>
  plans: Record<string, CollectionMap['plans']>
  profile: Record<string, CollectionMap['profile']>
}

function empty(): StoreShape {
  return { version: SCHEMA_VERSION, userId: `local-${Math.random().toString(36).slice(2, 10)}`, bills: {}, appliances: {}, plans: {}, profile: {} }
}

/**
 * Upgrade older stored shapes without losing data.
 * v1 -> v2: adds the `profile` collection (HouseholdProfile).
 */
export function migrate(raw: unknown): StoreShape {
  if (!raw || typeof raw !== 'object') return empty()
  const r = { ...(raw as Partial<StoreShape>) }
  const base = empty()
  return {
    version: SCHEMA_VERSION,
    userId: typeof r.userId === 'string' ? r.userId : base.userId,
    bills: r.bills ?? {},
    appliances: r.appliances ?? {},
    plans: r.plans ?? {},
    profile: r.profile ?? {},
  }
}

export class LocalRepo implements Repo {
  readonly mode = 'local' as const
  readonly isAnonymous = true
  private store: StoreShape
  private listeners = new Map<CollectionName, Set<(items: unknown[]) => void>>()
  private storage: Storage

  constructor(storage: Storage = window.localStorage) {
    this.storage = storage
    let parsed: unknown
    try {
      parsed = JSON.parse(storage.getItem(LOCAL_KEY) ?? 'null')
    } catch {
      parsed = null
    }
    this.store = migrate(parsed)
    this.persist()
    window.addEventListener?.('storage', (e) => {
      if (e.key === LOCAL_KEY && e.newValue) {
        this.store = migrate(JSON.parse(e.newValue))
        COLLECTIONS.forEach((c) => this.emit(c))
      }
    })
  }

  get userId() {
    return this.store.userId
  }

  private persist() {
    this.storage.setItem(LOCAL_KEY, JSON.stringify(this.store)) // throws on quota errors; callers surface it
  }

  private emit(c: CollectionName) {
    const items = Object.values(this.store[c])
    this.listeners.get(c)?.forEach((cb) => cb(items))
  }

  subscribe<C extends CollectionName>(c: C, cb: (items: CollectionMap[C][]) => void): () => void {
    const set = this.listeners.get(c) ?? new Set()
    set.add(cb as (items: unknown[]) => void)
    this.listeners.set(c, set)
    cb(Object.values(this.store[c]) as CollectionMap[C][])
    return () => set.delete(cb as (items: unknown[]) => void)
  }

  async put<C extends CollectionName>(c: C, item: CollectionMap[C]): Promise<void> {
    const prev = this.store[c][item.id] as CollectionMap[C] | undefined
    ;(this.store[c] as Record<string, CollectionMap[C]>)[item.id] = item
    try {
      this.persist()
    } catch (e) {
      if (prev) (this.store[c] as Record<string, CollectionMap[C]>)[item.id] = prev
      else delete this.store[c][item.id]
      throw e
    }
    this.emit(c)
  }

  async remove(c: CollectionName, id: string): Promise<void> {
    delete this.store[c][id]
    this.persist()
    this.emit(c)
  }

  async clearAll(): Promise<void> {
    this.store = { ...empty(), userId: this.store.userId }
    this.persist()
    COLLECTIONS.forEach((c) => this.emit(c))
  }
}
