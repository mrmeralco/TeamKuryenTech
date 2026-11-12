import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { Alert } from './ui/alert'

type Tone = 'success' | 'error' | 'info'
const Ctx = createContext<(msg: string, tone?: Tone) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; tone: Tone; id: number } | null>(null)
  const show = useCallback((msg: string, tone: Tone = 'success') => {
    const id = Date.now()
    setToast({ msg, tone, id })
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 4000)
  }, [])
  return (
    <Ctx.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4 md:bottom-6">
        {toast && (
          <Alert tone={toast.tone} className="pointer-events-auto max-w-md shadow-lg" role="status">
            {toast.msg}
          </Alert>
        )}
      </div>
    </Ctx.Provider>
  )
}
export const useToast = () => useContext(Ctx)
