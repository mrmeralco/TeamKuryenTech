import { ScanLine } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { useToast } from '@/components/Toast'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Field, focusFirstInvalid, Input, Select, Textarea } from '@/components/ui/field'
import { useI18n, type TKey } from '@/i18n'
import { ApiError, isAcceptableImage, ocrLabel, type LabelOcrResult } from '@/lib/api'
import { useData } from '@/lib/data'
import { periodDays } from '@/lib/dates'
import { clearDraft, loadDraft, saveDraft } from '@/lib/drafts'
import { MAX_DAYS, safeApplianceKwh } from '@/lib/energy'
import { kwh as fmtKwh, parseNumberInput } from '@/lib/format'
import { useOnline } from '@/lib/useOnline'
import { APPLIANCE_TYPES, type ApplianceType } from '@/lib/types'
import {
  APPLIANCE_FIELD_ORDER, draftFromAppliance, TYPICAL_WATTAGE, validateAppliance, VARIABLE_POWER,
  type ApplianceDraft, type ApplianceField, type FieldErrors,
} from '@/lib/validation'

const emptyDraft = (days: number | null, defaultName: string): ApplianceDraft => ({
  name: defaultName, type: 'fan', wattage: '', quantity: '1', hoursPerDay: '', daysPerPeriod: days ? String(days) : '30', notes: '',
})

export default function ApplianceForm() {
  const { id } = useParams()
  const { t, lang } = useI18n()
  const nav = useNavigate()
  const toast = useToast()
  const online = useOnline()
  const { appliances, ready, latest, saveAppliance } = useData()
  const billDays = latest ? periodDays(latest.periodStart, latest.periodEnd) : null
  const maxDays = billDays ?? MAX_DAYS
  const formRef = useRef<HTMLFormElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<ApplianceDraft | null>(() => (id ? null : (loadDraft<ApplianceDraft>('appliance') ?? emptyDraft(billDays, t('type.fan')))))
  const [errors, setErrors] = useState<FieldErrors<ApplianceField>>({})
  const [saving, setSaving] = useState(false)
  const [scan, setScan] = useState<{ busy: boolean; result?: LabelOcrResult; error?: string }>({ busy: false })

  useEffect(() => {
    if (id && ready && !draft) {
      const a = appliances.find((x) => x.id === id)
      if (a) setDraft(draftFromAppliance(a))
      else nav('/appliances', { replace: true })
    }
  }, [id, ready, appliances, draft, nav])

  if (!draft) return <p role="status">{t('status.loading')}</p>

  const update = (patch: Partial<ApplianceDraft>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    if (!id) saveDraft('appliance', next)
    setErrors((e) => {
      const c = { ...e }
      for (const k of Object.keys(patch)) delete c[k as ApplianceField]
      return c
    })
  }

  const onType = (type: ApplianceType) => {
    const prevLabel = t(`type.${draft.type}` as TKey)
    update({ type, name: !draft.name || draft.name === prevLabel ? t(`type.${type}` as TKey) : draft.name })
  }

  const onScan = async (f: File | undefined) => {
    if (!f) return
    if (!isAcceptableImage(f)) {
      setScan({ busy: false, error: t('bill.badFile') })
      return
    }
    setScan({ busy: true })
    try {
      setScan({ busy: false, result: await ocrLabel(f) })
    } catch (e) {
      setScan({ busy: false, error: e instanceof ApiError && e.code === 'offline' ? t('bill.ocrOffline') : t('bill.ocrUnavailable') })
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const submit = async () => {
    if (saving) return
    const { errors: errs, value } = validateAppliance(draft, maxDays)
    setErrors(errs)
    if (!value) {
      requestAnimationFrame(() => focusFirstInvalid(APPLIANCE_FIELD_ORDER, errs, formRef.current ?? document))
      return
    }
    setSaving(true)
    try {
      await saveAppliance(value, id)
      if (!id) clearDraft('appliance')
      nav('/appliances')
    } catch {
      toast(t('err.save'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const e = (k: ApplianceField) => (errors[k] ? t(errors[k] as TKey) : undefined)
  const typical = TYPICAL_WATTAGE[draft.type]
  const preview = (() => {
    const v = validateAppliance(draft, maxDays).value
    return v ? safeApplianceKwh({ ...v, id: '', confirmed: false, createdAt: '', updatedAt: '' }) : null
  })()

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader step="02 · 7–8" title={id ? t('appl.edit') : t('appl.add')} body={t('appl.body')} />
      <Card>
        <CardContent className="pt-4 sm:pt-5">
          <form ref={formRef} noValidate onSubmit={(ev) => { ev.preventDefault(); void submit() }} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field name="type" label={t('appl.type')} error={e('type')}>
                {({ id: fid, describedBy, invalid }) => (
                  <Select id={fid} value={draft.type} aria-invalid={invalid} aria-describedby={describedBy} onChange={(ev) => onType(ev.target.value as ApplianceType)}>
                    {APPLIANCE_TYPES.map((ty) => (
                      <option key={ty} value={ty}>
                        {t(`type.${ty}` as TKey)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field name="name" label={t('appl.name')} error={e('name')}>
                {({ id: fid, describedBy, invalid }) => (
                  <Input id={fid} value={draft.name} placeholder={t('appl.namePlaceholder')} maxLength={60} aria-invalid={invalid} aria-describedby={describedBy} onChange={(ev) => update({ name: ev.target.value })} />
                )}
              </Field>
            </div>

            <Field name="wattage" label={t('appl.wattage')} error={e('wattage')} hint={typical ? t('appl.wattageHint', { w: typical }) : t('appl.wattageHintNone')}>
              {({ id: fid, describedBy, invalid }) => (
                <div className="flex gap-2">
                  <Input id={fid} inputMode="decimal" value={draft.wattage} aria-invalid={invalid} aria-describedby={describedBy} onChange={(ev) => update({ wattage: ev.target.value })} />
                  <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={scan.busy || !online} className="shrink-0">
                    <ScanLine className="size-4" aria-hidden /> <span className="hidden sm:inline">{scan.busy ? t('appl.scanning') : t('appl.scanLabel')}</span>
                    <span className="sr-only sm:hidden">{t('appl.scanLabel')}</span>
                  </Button>
                </div>
              )}
            </Field>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1} aria-hidden data-testid="label-file" onChange={(ev) => onScan(ev.target.files?.[0])} />
            {scan.error && <Alert tone="error">{scan.error}</Alert>}
            {scan.result && (
              <Alert tone={scan.result.suggestedWattage ? 'info' : 'warning'}>
                {scan.result.suggestedWattage ? (
                  <div className="space-y-2">
                    <p>{t('appl.labelFound', { w: scan.result.suggestedWattage })}</p>
                    <div className="flex flex-wrap gap-2">
                      {scan.result.candidates.map((w) => (
                        <Button key={w} size="sm" variant={w === scan.result!.suggestedWattage ? 'default' : 'outline'} onClick={() => { update({ wattage: String(w) }); setScan({ busy: false }) }}>
                          {t('appl.useValue', { w })}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : (
                  t('appl.labelNone')
                )}
              </Alert>
            )}
            {VARIABLE_POWER.has(draft.type) && <Alert tone="warning">{t('appl.variable')}</Alert>}

            <div className="grid gap-4 sm:grid-cols-3">
              <Field name="quantity" label={t('appl.quantity')} error={e('quantity')}>
                {({ id: fid, describedBy, invalid }) => (
                  <Input id={fid} inputMode="numeric" value={draft.quantity} aria-invalid={invalid} aria-describedby={describedBy} onChange={(ev) => update({ quantity: ev.target.value })} />
                )}
              </Field>
              <Field name="hoursPerDay" label={t('appl.hours')} error={e('hoursPerDay')}>
                {({ id: fid, describedBy, invalid }) => (
                  <Input id={fid} inputMode="decimal" value={draft.hoursPerDay} aria-invalid={invalid} aria-describedby={describedBy} onChange={(ev) => update({ hoursPerDay: ev.target.value })} />
                )}
              </Field>
              <Field name="daysPerPeriod" label={t('appl.days')} error={e('daysPerPeriod')} hint={billDays ? t('appl.daysHint', { days: billDays }) : undefined}>
                {({ id: fid, describedBy, invalid }) => (
                  <Input id={fid} inputMode="numeric" value={draft.daysPerPeriod} aria-invalid={invalid} aria-describedby={describedBy} onChange={(ev) => update({ daysPerPeriod: ev.target.value })} />
                )}
              </Field>
            </div>
            <Field name="notes" label={`${t('appl.notes')} (${t('common.optional')})`} error={e('notes')}>
              {({ id: fid, describedBy, invalid }) => (
                <Textarea id={fid} rows={2} maxLength={200} value={draft.notes} aria-invalid={invalid} aria-describedby={describedBy} onChange={(ev) => update({ notes: ev.target.value })} />
              )}
            </Field>

            {preview !== null && parseNumberInput(draft.wattage) !== null && (
              <p className="text-sm text-slate-700" data-testid="appliance-preview">
                {t('appl.estimate', { kwh: fmtKwh(preview, lang) })} <span className="text-slate-500">({t('common.estimate')})</span>
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" disabled={saving} className="sm:flex-1">
                {saving ? t('common.saving') : t('appl.saveItem')}
              </Button>
              <Button variant="outline" onClick={() => nav('/appliances')} className="sm:flex-1">
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
