import type { ReactNode } from 'react'
import { Button } from './ui/button'

/** A flowchart decision diamond rendered as a question with explicit Yes / No actions. */
export function Decision(props: {
  step: number
  question: string
  yesLabel: string
  noLabel: string
  onYes: () => void
  onNo: () => void
  busy?: boolean
  children?: ReactNode
}) {
  return (
    <section aria-labelledby={`decision-${props.step}`} className="rounded-xl border-2 border-dashed border-brand-600/40 bg-brand-50 p-4">
      <h2 id={`decision-${props.step}`} className="flex items-center gap-2 font-semibold text-brand-900">
        <span aria-hidden className="inline-block size-3 rotate-45 bg-brand-700" />
        {props.question}
      </h2>
      {props.children}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Button onClick={props.onYes} disabled={props.busy} className="sm:flex-1">
          {props.yesLabel}
        </Button>
        <Button variant="outline" onClick={props.onNo} disabled={props.busy} className="sm:flex-1">
          {props.noLabel}
        </Button>
      </div>
    </section>
  )
}
