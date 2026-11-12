import type { ReactNode } from 'react'

export function PageHeader({ step, title, body, actions }: { step?: string; title: string; body?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {step && <p className="text-xs font-semibold tracking-wide text-brand-700 uppercase">{step}</p>}
        <h1 className="text-2xl font-bold text-slate-900 text-balance">{title}</h1>
        {body && <p className="mt-1 max-w-2xl text-sm text-slate-600">{body}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </header>
  )
}
