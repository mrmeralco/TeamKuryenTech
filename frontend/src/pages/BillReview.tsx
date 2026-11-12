import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Decision } from '@/components/Decision'
import { PageHeader } from '@/components/PageHeader'
import { useToast } from '@/components/Toast'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Field, focusFirstInvalid, Input } from '@/components/ui/field'
import { useI18n, type TKey } from '@/i18n'
import { useData } from '@/lib/data'
import { periodDays } from '@/lib/dates'
import { clearDraft, loadDraft, saveDraft } from '@/lib/drafts'
import { parseNumberInput, php } from '@/lib/format'
import { billDerivedRate } from '@/lib/rates'
import type { Bill } from '@/lib/types'
import { BILL_FIELD_ORDER, emptyBillDraft, validateBill, type BillDraft, type BillField, type FieldErrors, type RateChoice } from '@/lib/validation'

const draftFromBill = (b: Bill): BillDraft => ({
  id: b.id,
  periodStart: b.periodStart,
  periodEnd: b.periodEnd,
  kwh: String(b.kwh),
  amountPhp: String(b.amountPhp),
  rateChoice: b.rate?.source ?? 'none',
  rateValue: b.rate?.source === 'user_entered' ? String(b.rate.valuePhpPerKwh) : '',
  rateMonth: b.rate?.source === 'user_entered' ? b.rate.month : '',
  charges: b.charges,
  source: b.source,
})

export default function BillReview() {
  const { id } = useParams()
  const { t, lang } = useI18n()
  const nav = useNavigate()
  const toast = useToast()
  const { bills, ready, saveBill, findBillForPeriod } = useData()
  const formRef = useRef<HTMLFormElement>(null)
  const [draft, setDraft] = useState<BillDraft | null>(() => (id ? null : (loadDraft<BillDraft>('bill') ?? emptyBillDraft('manual'))))
  const [errors, setErrors] = useState<FieldErrors<BillField>>({})
  const [fixing, setFixing] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (id && ready && !draft) {
      const b = bills.find((x) => x.id === id)
      if (b) setDraft(draftFromBill(b))
      else nav('/bill', { replace: true })
    }
  }, [id, ready, bills, draft, nav])

  const update = (patch: Partial<BillDraft>) => {
    setDraft((d) => {
      const next = { ...(d as BillDraft), ...patch }
      if (!id) saveDraft('bill', next)
      return next
    })
    setErrors((e) => {
      const copy = { ...e }
      for (const k of Object.keys(patch)) delete copy[k as BillField]
      return copy
    })
  }

  const days = draft ? periodDays(draft.periodStart, draft.periodEnd) : null
  const derived = useMemo(() => {
    if (!draft) return null
    const k = parseNumberInput(draft.kwh)
    const a = parseNumberInput(draft.amountPhp)
    return k !== null && a !== null && draft.periodEnd ? billDerivedRate(a, k, draft.periodEnd) : null
  }, [draft])
  const duplicate = draft && draft.periodStart && draft.periodEnd ? findBillForPeriod(draft.periodStart, draft.periodEnd, draft.id) : undefined

  if (!draft) return <p role="status">{t('status.loading')}</p>

  const confirm = async () => {
    if (saving) return
    const { errors: errs, value } = validateBill(draft)
    setErrors(errs)
    if (!value) {
      setFixing(true)
      requestAnimationFrame(() => focusFirstInvalid(BILL_FIELD_ORDER, errs, formRef.current ?? document))
      return
    }
    setSaving(true)
    try {
      await saveBill(value, draft.id)
      clearDraft('bill')
      toast(t('bill.saved'))
      nav('/appliances')
    } catch {
      toast(t('err.save'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const fix = () => {
    setFixing(true)
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLInputElement>('input')?.focus())
  }

  const e = (k: BillField) => (errors[k] ? t(errors[k] as TKey) : undefined)
  const missing = (k: string) => (draft.source === 'ocr' && draft.ocrMissing?.includes(k) ? t('review.notFound') : undefined)
  const rateOptions: RateChoice[] = ['bill_derived', 'user_entered', 'reference', 'none']

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader step="01 · 4" title={t('review.title')} />
      <Alert tone={draft.source === 'ocr' ? 'warning' : 'info'}>{t(draft.source === 'ocr' ? 'review.ocrNote' : 'review.manualNote')}</Alert>
      {draft.source === 'ocr' && draft.ocrLowConfidence && <Alert tone="warning">{t('review.lowConfidence')}</Alert>}

      <Card>
        <CardContent className="pt-4 sm:pt-5">
          <form
            ref={formRef}
            noValidate
            onSubmit={(ev) => { ev.preventDefault(); void confirm() }}
            // The Yes/No decision lives outside the form, so browsers would not submit on Enter; do it explicitly.
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && ev.target instanceof HTMLInputElement && ev.target.type !== 'radio') {
                ev.preventDefault()
                void confirm()
              }
            }}
            className="space-y-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field name="periodStart" label={t('review.periodStart')} error={e('periodStart')} hint={missing('periodStart')}>
                {({ id: fid, describedBy, invalid }) => (
                  <Input id={fid} type="date" value={draft.periodStart} aria-invalid={invalid} aria-describedby={describedBy} onChange={(ev) => update({ periodStart: ev.target.value })} />
                )}
              </Field>
              <Field name="periodEnd" label={t('review.periodEnd')} error={e('periodEnd')} hint={missing('periodEnd') ?? (days && days > 1 && !errors.periodEnd ? t('review.days', { days }) : undefined)}>
                {({ id: fid, describedBy, invalid }) => (
                  <Input id={fid} type="date" value={draft.periodEnd} aria-invalid={invalid} aria-describedby={describedBy} onChange={(ev) => update({ periodEnd: ev.target.value })} />
                )}
              </Field>
              <Field name="kwh" label={t('review.kwh')} error={e('kwh')} hint={missing('kwh')}>
                {({ id: fid, describedBy, invalid }) => (
                  <Input id={fid} inputMode="decimal" value={draft.kwh} aria-invalid={invalid} aria-describedby={describedBy} onChange={(ev) => update({ kwh: ev.target.value })} />
                )}
              </Field>
              <Field name="amountPhp" label={t('review.amount')} error={e('amountPhp')} hint={missing('amountPhp')}>
                {({ id: fid, describedBy, invalid }) => (
                  <Input id={fid} inputMode="decimal" value={draft.amountPhp} aria-invalid={invalid} aria-describedby={describedBy} onChange={(ev) => update({ amountPhp: ev.target.value })} />
                )}
              </Field>
            </div>

            <fieldset className="space-y-2" data-field="rateChoice">
              <legend className="text-sm font-medium text-slate-800">{t('review.rate')}</legend>
              {rateOptions.map((opt) => (
                <label key={opt} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-2 text-sm has-checked:border-brand-600 has-checked:bg-brand-50">
                  <input type="radio" name="rateChoice" className="mt-1 size-4 accent-brand-700" checked={draft.rateChoice === opt} onChange={() => update({ rateChoice: opt })} />
                  <span>
                    {t(`review.rate.${opt}` as TKey)}
                    {opt === 'bill_derived' && derived && <span className="block text-xs text-slate-600">{t('review.derived', { rate: php(derived.valuePhpPerKwh, lang) })}</span>}
                  </span>
                </label>
              ))}
              {errors.rateChoice && (
                <p role="alert" className="text-sm font-medium text-red-700">
                  ⚠ {t(errors.rateChoice)}
                </p>
              )}
            </fieldset>

            {draft.rateChoice === 'user_entered' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field name="rateValue" label={t('review.rateValue')} error={e('rateValue')}>
                  {({ id: fid, describedBy, invalid }) => (
                    <Input id={fid} inputMode="decimal" value={draft.rateValue} aria-invalid={invalid} aria-describedby={describedBy} onChange={(ev) => update({ rateValue: ev.target.value })} />
                  )}
                </Field>
                <Field name="rateMonth" label={t('review.rateMonth')} error={e('rateMonth')}>
                  {({ id: fid, describedBy, invalid }) => (
                    <Input id={fid} type="month" placeholder="2026-10" value={draft.rateMonth} aria-invalid={invalid} aria-describedby={describedBy} onChange={(ev) => update({ rateMonth: ev.target.value })} />
                  )}
                </Field>
              </div>
            )}

            {draft.charges.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium">{t('review.charges')}</p>
                <ul className="space-y-1 text-sm">
                  {draft.charges.map((c) => (
                    <li key={c.key} className="flex items-center justify-between gap-2 rounded bg-slate-50 px-2 py-1">
                      <span className="capitalize">{c.key.replace('_', ' ')}</span>
                      <span className="flex items-center gap-2">
                        {php(c.amountPhp, lang)}
                        <Button size="sm" variant="ghost" onClick={() => update({ charges: draft.charges.filter((x) => x.key !== c.key) })}>
                          {t('review.removeCharge')}
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {Object.keys(errors).length > 0 && <Alert tone="error">{t('review.fixErrors')}</Alert>}
            {duplicate && <Alert tone="warning">{t('review.duplicate')}</Alert>}
          </form>
        </CardContent>
      </Card>

      <Decision step={5} question={t('review.question')} yesLabel={saving ? t('common.saving') : t('review.yes')} noLabel={t('review.no')} onYes={confirm} onNo={fix} busy={saving}>
        {fixing && (
          <div className="mt-2 space-y-2 text-sm">
            <p>{t('review.fixHint')}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => nav('/bill')}>
                {t('review.retake')}
              </Button>
              {draft.source === 'ocr' && (
                <Button size="sm" variant="outline" onClick={() => update({ source: 'manual' })}>
                  {t('review.toManual')}
                </Button>
              )}
            </div>
          </div>
        )}
      </Decision>
    </div>
  )
}
