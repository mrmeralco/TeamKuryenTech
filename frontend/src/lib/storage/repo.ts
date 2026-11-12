import type { CollectionMap, CollectionName } from '../types'

export type SyncState = 'local-only' | 'synced' | 'pending'

export interface Repo {
  readonly mode: 'local' | 'firestore'
  readonly userId: string
  readonly isAnonymous: boolean
  subscribe<C extends CollectionName>(c: C, cb: (items: CollectionMap[C][]) => void, onError: (e: Error) => void): () => void
  put<C extends CollectionName>(c: C, item: CollectionMap[C]): Promise<void>
  remove(c: CollectionName, id: string): Promise<void>
  clearAll(): Promise<void>
  onSyncState?(cb: (s: SyncState) => void): () => void
  upgradeAccount?(): Promise<void>
}

export const COLLECTIONS: CollectionName[] = ['bills', 'appliances', 'plans', 'profile']

export const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
