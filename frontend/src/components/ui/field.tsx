import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const control =
  'w-full min-h-11 rounded-lg border bg-white px-3 py-2 text-base text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600 aria-[invalid=true]:border-red-600 aria-[invalid=true]:ring-red-600'

interface FieldProps {
  label: ReactNode
  error?: string
  hint?: ReactNode
  name: string
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode
}

export function Field({ label, error, hint, name, children }: FieldProps) {
  const base = useId()
  const id = `${name}-${base}`
  const hintId = hint ? `${id}-hint` : undefined
  const errId = error ? `${id}-err` : undefined
  return (
    <div className="space-y-1.5" data-field={name}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      {children({ id, describedBy: [hintId, errId].filter(Boolean).join(' ') || undefined, invalid: !!error })}
      {hint && (
        <p id={hintId} className="text-xs text-slate-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="text-sm font-medium text-red-700" role="alert">
          ⚠ {error}
        </p>
      )}
    </div>
  )
}

export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input className={cn(control, 'border-slate-300', className)} {...p} />
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select className={cn(control, 'border-slate-300', className)} {...p} />
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={cn(control, 'border-slate-300', className)} {...p} />
)

/** Focus and scroll to the first invalid field in the given order. */
export function focusFirstInvalid(order: string[], errors: Record<string, unknown>, root: ParentNode = document) {
  const first = order.find((k) => errors[k])
  if (!first) return
  const el = root.querySelector<HTMLElement>(`[data-field="${first}"] input, [data-field="${first}"] select, [data-field="${first}"] textarea`)
  el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  el?.focus()
}
