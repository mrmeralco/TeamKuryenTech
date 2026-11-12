import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { latestBill } from './analytics'
import { firebaseConfigFromEnv } from './storage/firebaseConfig'
import { LocalRepo } from './storage/localRepo'
import { newId, type Repo, type SyncState } from './storage/repo'
import type { Appliance, Bill, HouseholdProfile, Plan, Rate } from './types'
import type { ValidAppliance, ValidBill } from './validation'

interface DataValue {
  ready: boolean
  error: string | null
  repo: Repo | null
  mode: 'local' | 'firestore'
  sync: SyncState
  bills: Bill[]
  appliances: Appliance[]
  plans: Plan[]
  profile: HouseholdProfile | null
  saveProfile: (language: HouseholdProfile['language']) => Promise<void>
  latest: Bill | null
  rate: Rate | null
  saveBill: (v: ValidBill, id?: string) => Promise<Bill>
  deleteBill: (id: string) => Promise<void>
  findBillForPeriod: (start: string, end: string, excludeId?: string) => Bill | undefined
  saveAppliance: (v: ValidAppliance, id?: string) => Promise<Appliance>
  deleteAppliance: (id: string) => Promise<void>
  confirmAppliances: () => Promise<void>
  savePlan: (p: Omit<Plan, 'id' | 'createdAt' | 'updatedAt' | 'recalculatedAt'> & { recalculatedAt?: string | null }, id?: string) => Promise<Plan>
  deletePlan: (id: string) => Promise<void>
  clearAll: () => Promise<void>
}

const DataContext = createContext<DataValue | null>(null)
const now = () => new Date().toISOString()

export function DataProvider({ children, repoFactory }: { children: ReactNode; repoFactory?: () => Promise<Repo> }) {
  const [repo, setRepo] = useState<Repo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bills, setBills] = useState<Bill[]>([])
  const [appliances, setAppliances] = useState<Appliance[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [profile, setProfile] = useState<HouseholdProfile | null>(null)
  const [loaded, setLoaded] = useState({ bills: false, appliances: false, plans: false, profile: false })
  const [sync, setSync] = useState<SyncState>('local-only')
  const inflight = useRef(false)

  useEffect(() => {
    let cancelled = false
    const unsubs: Array<() => void> = []
    ;(async () => {
      let r: Repo
      try {
        if (repoFactory) r = await repoFactory()
        else {
          const cfg = firebaseConfigFromEnv()
          if (cfg) {
            try {
              const { createFirestoreRepo } = await import('./storage/firebase')
              r = await createFirestoreRepo(cfg)
            } catch (e) {
              // e.g. first visit while offline: anonymous sign-in needs the network once.
              console.warn('Firebase unavailable, using local storage for this session', (e as { code?: string })?.code ?? e)
              r = new LocalRepo()
            }
          } else r = new LocalRepo()
        }
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message ?? e))
        return
      }
      if (cancelled) return
      setRepo(r)
      const onErr = (e: Error) => setError(e.message)
      unsubs.push(r.subscribe('bills', (x) => { setBills(x); setLoaded((l) => ({ ...l, bills: true })) }, onErr))
      unsubs.push(r.subscribe('appliances', (x) => { setAppliances(x); setLoaded((l) => ({ ...l, appliances: true })) }, onErr))
      unsubs.push(r.subscribe('plans', (x) => { setPlans(x); setLoaded((l) => ({ ...l, plans: true })) }, onErr))
      unsubs.push(r.subscribe('profile', (x) => { setProfile(x.find((p) => p.id === 'household') ?? null); setLoaded((l) => ({ ...l, profile: true })) }, onErr))
      if (r.onSyncState) unsubs.push(r.onSyncState(setSync))
    })()
    return () => {
      cancelled = true
      unsubs.forEach((u) => u())
    }
  }, [repoFactory])

  const need = useCallback(() => {
    if (!repo) throw new Error('storage not ready')
    return repo
  }, [repo])

  const findBillForPeriod = useCallback(
    (start: string, end: string, excludeId?: string) => bills.find((b) => b.periodStart === start && b.periodEnd === end && b.id !== excludeId),
    [bills],
  )

  const saveBill = useCallback(
    async (v: ValidBill, id?: string) => {
      // Same billing period = same bill: update instead of duplicating.
      const self = id ? bills.find((b) => b.id === id) : undefined
      const dup = findBillForPeriod(v.periodStart, v.periodEnd, id)
      const target = dup ?? self
      const bill: Bill = { ...v, id: target?.id ?? newId(), createdAt: target?.createdAt ?? now(), updatedAt: now() }
      await need().put('bills', bill)
      if (self && dup) await need().remove('bills', self.id)
      return bill
    },
    [bills, findBillForPeriod, need],
  )

  const saveAppliance = useCallback(
    async (v: ValidAppliance, id?: string) => {
      const existing = id ? appliances.find((a) => a.id === id) : undefined
      // Any edit returns the item to draft until the list is confirmed again (flowchart step 10/11).
      const a: Appliance = { ...v, id: existing?.id ?? newId(), confirmed: false, createdAt: existing?.createdAt ?? now(), updatedAt: now() }
      await need().put('appliances', a)
      return a
    },
    [appliances, need],
  )

  const confirmAppliances = useCallback(async () => {
    if (inflight.current) return
    inflight.current = true
    try {
      for (const a of appliances) if (!a.confirmed) await need().put('appliances', { ...a, confirmed: true, updatedAt: now() })
    } finally {
      inflight.current = false
    }
  }, [appliances, need])

  const savePlan = useCallback<DataValue['savePlan']>(
    async (p, id) => {
      const existing = id ? plans.find((x) => x.id === id) : undefined
      const plan: Plan = {
        ...p,
        id: existing?.id ?? newId(),
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
        recalculatedAt: p.recalculatedAt ?? existing?.recalculatedAt ?? null,
      }
      await need().put('plans', plan)
      return plan
    },
    [plans, need],
  )

  const latest = useMemo(() => latestBill(bills), [bills])
  const value: DataValue = {
    ready: !!repo && loaded.bills && loaded.appliances && loaded.plans && loaded.profile,
    error,
    repo,
    mode: repo?.mode ?? 'local',
    sync: repo?.mode === 'local' ? 'local-only' : sync,
    bills,
    appliances: useMemo(() => [...appliances].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [appliances]),
    plans: useMemo(() => [...plans].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [plans]),
    profile,
    saveProfile: async (language) => {
      const t = now()
      await need().put('profile', { id: 'household', language, createdAt: profile?.createdAt ?? t, updatedAt: t })
    },
    latest,
    rate: latest?.rate ?? null,
    saveBill,
    deleteBill: (id) => need().remove('bills', id),
    findBillForPeriod,
    saveAppliance,
    deleteAppliance: (id) => need().remove('appliances', id),
    confirmAppliances,
    savePlan,
    deletePlan: (id) => need().remove('plans', id),
    clearAll: () => need().clearAll(),
  }
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData(): DataValue {
  const v = useContext(DataContext)
  if (!v) throw new Error('useData must be used inside DataProvider')
  return v
}
