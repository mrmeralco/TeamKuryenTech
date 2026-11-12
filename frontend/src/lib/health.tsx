import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { getHealth, type Health } from './api'
import { useOnline } from './useOnline'

type HealthState = { status: 'checking' } | { status: 'ok'; health: Health } | { status: 'down' }
const Ctx = createContext<HealthState>({ status: 'checking' })

export function HealthProvider({ children }: { children: ReactNode }) {
  const online = useOnline()
  const [state, setState] = useState<HealthState>({ status: 'checking' })
  useEffect(() => {
    let alive = true
    if (!online) {
      setState({ status: 'down' })
      return
    }
    getHealth()
      .then((h) => alive && setState({ status: 'ok', health: h }))
      .catch(() => alive && setState({ status: 'down' }))
    return () => {
      alive = false
    }
  }, [online])
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>
}

export const useHealth = () => useContext(Ctx)
