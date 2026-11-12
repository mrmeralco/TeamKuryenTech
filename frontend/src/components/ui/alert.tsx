import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

const styles = {
  info: ['border-sky-200 bg-sky-50 text-sky-900', Info],
  success: ['border-emerald-200 bg-emerald-50 text-emerald-900', CheckCircle2],
  warning: ['border-amber-300 bg-amber-50 text-amber-950', AlertTriangle],
  error: ['border-red-200 bg-red-50 text-red-900', XCircle],
} as const

export function Alert({ tone = 'info', children, className, role }: { tone?: keyof typeof styles; children: ReactNode; className?: string; role?: string }) {
  const [cls, Icon] = styles[tone]
  return (
    <div role={role ?? (tone === 'error' ? 'alert' : 'status')} className={cn('flex gap-2 rounded-lg border p-3 text-sm', cls, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', className)}>{children}</span>
}
