import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Decision } from '@/components/Decision'
import { PageHeader } from '@/components/PageHeader'
import { useToast } from '@/components/Toast'
import { Alert, Badge } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useI18n, type TKey } from '@/i18n'
import { useData } from '@/lib/data'
import { periodDays } from '@/lib/dates'
import { MAX_DAYS, round2, safeApplianceKwh } from '@/lib/energy'
import { kwh as fmtKwh, num } from '@/lib/format'
import { validateStoredAppliance, VARIABLE_POWER } from '@/lib/validation'

export default function Appliances() {
  const { t, lang } = useI18n()
  const nav = useNavigate()
  const toast = useToast()
  const { appliances, latest, deleteAppliance, confirmAppliances, ready } = useData()
  const [fixing, setFixing] = useState(false)
  const [busy, setBusy] = useState(false)
  const maxDays = (latest && periodDays(latest.periodStart, latest.periodEnd)) || MAX_DAYS

  const rows = appliances.map((a) => ({ a, kwh: safeApplianceKwh(a), invalid: !validateStoredAppliance(a, maxDays).value }))
  const total = round2(rows.reduce((s, r) => s + (r.kwh ?? 0), 0))
  const anyInvalid = rows.some((r) => r.invalid)

  const yes = async () => {
    if (appliances.length === 0) {
      toast(t('appl.needOne'), 'error')
      return
    }
    if (anyInvalid) {
      setFixing(true)
      document.querySelector<HTMLElement>('[data-invalid="true"] a')?.focus()
      return
    }
    setBusy(true)
    try {
      await confirmAppliances()
      toast(t('appl.saved'))
      nav('/simulator')
    } catch {
      toast(t('err.save'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        step="02 · 9"
        title={t('appl.title')}
        body={t('appl.body')}
        actions={
          <Button asChild>
            <Link to="/appliances/new">
              <Plus className="size-4" aria-hidden /> {appliances.length ? t('appl.addAnother') : t('appl.add')}
            </Link>
          </Button>
        }
      />
      {!ready ? (
        <p role="status">{t('status.loading')}</p>
      ) : rows.length === 0 ? (
        <Alert>{t('appl.empty')}</Alert>
      ) : (
        <>
          <p className="text-sm text-slate-600">{t('appl.summary', { count: rows.length, kwh: fmtKwh(total, lang) })}</p>
          <ul className="grid gap-3 md:grid-cols-2" aria-label={t('appl.title')}>
            {rows.map(({ a, kwh, invalid }) => (
              <li key={a.id} data-invalid={invalid} className={`rounded-xl border bg-white p-3 ${invalid ? 'border-red-400' : 'border-slate-200'}`}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{a.name}</p>
                    <p className="text-xs text-slate-500">{t(`type.${a.type}` as TKey)}</p>
                  </div>
                  {invalid ? (
                    <Badge className="border-red-300 bg-red-50 text-red-800">⚠ {t('appl.invalid')}</Badge>
                  ) : a.confirmed ? (
                    <Badge className="border-emerald-300 bg-emerald-50 text-emerald-800">✓ {t('appl.confirmedBadge')}</Badge>
                  ) : (
                    <Badge className="border-amber-300 bg-amber-50 text-amber-900">{t('appl.draft')}</Badge>
                  )}
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:grid-cols-4">
                  <div><dt className="text-xs text-slate-500">W</dt><dd>{num(a.wattage, lang)}</dd></div>
                  <div><dt className="text-xs text-slate-500">×</dt><dd>{a.quantity}</dd></div>
                  <div><dt className="text-xs text-slate-500">{lang === 'fil' ? 'oras/araw' : 'h/day'}</dt><dd>{num(a.hoursPerDay, lang)}</dd></div>
                  <div><dt className="text-xs text-slate-500">{lang === 'fil' ? 'araw' : 'days'}</dt><dd>{num(a.daysPerPeriod, lang)}</dd></div>
                </dl>
                {kwh !== null && <p className="mt-2 text-sm font-medium text-brand-800">{t('appl.estimate', { kwh: fmtKwh(kwh, lang) })}</p>}
                {VARIABLE_POWER.has(a.type) && <p className="mt-1 text-xs text-amber-800">{t('appl.variable')}</p>}
                <div className="mt-2 flex gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/appliances/${a.id}/edit`} aria-label={`${t('common.edit')} ${a.name}`}>
                      <Pencil className="size-4" aria-hidden /> {t('common.edit')}
                    </Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${t('common.delete')} ${a.name}`}
                    onClick={async () => {
                      if (window.confirm(t('common.confirmDelete'))) await deleteAppliance(a.id)
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden /> {t('common.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <Decision step={10} question={t('appl.question')} yesLabel={busy ? t('common.saving') : t('appl.yes')} noLabel={t('appl.no')} onYes={yes} onNo={() => setFixing(true)} busy={busy}>
        {fixing && <p className="mt-2 text-sm">{t('appl.fixList')}</p>}
        {fixing && anyInvalid && <Alert tone="error" className="mt-2">{t('review.fixErrors')}</Alert>}
      </Decision>
    </div>
  )
}
