import { Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { useToast } from '@/components/Toast'
import { Alert, Badge } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { useData } from '@/lib/data'
import { compare, round2, usageOf } from '@/lib/energy'
import { dateLabel, kwh as fmtKwh, num, php } from '@/lib/format'
import type { Appliance, Plan, Rate } from '@/lib/types'

const sameUsage = (a: Plan['baseline'], b: Plan['baseline']) =>
  a.wattage === b.wattage && a.hoursPerDay === b.hoursPerDay && a.days === b.days && a.quantity === b.quantity

export function isPlanStale(p: Plan, appliance: Appliance | undefined, rate: Rate | null): boolean {
  if (!appliance) return false
  return !sameUsage(p.baseline, usageOf(appliance)) || (p.rate?.valuePhpPerKwh ?? null) !== (rate?.valuePhpPerKwh ?? null)
}

export default function Plans() {
  const { t, lang } = useI18n()
  const toast = useToast()
  const { plans, appliances, rate, savePlan, deletePlan, ready } = useData()
  const [selected, setSelected] = useState<string[]>([])

  const recalc = async (p: Plan, a: Appliance) => {
    const baseline = usageOf(a)
    try {
      const result = compare(baseline, p.scenario, rate?.valuePhpPerKwh ?? null)
      await savePlan({ ...p, baseline, rate, result, recalculatedAt: new Date().toISOString() }, p.id)
    } catch {
      toast(t('sim.invalid'), 'error')
    }
  }

  if (!ready) return <p role="status">{t('status.loading')}</p>

  const withPeso = plans.filter((p) => p.result.savedPhp !== null)
  const totalKwh = round2(plans.reduce((s, p) => s + p.result.savedKwh, 0))
  const totalPhp = round2(withPeso.reduce((s, p) => s + (p.result.savedPhp ?? 0), 0))
  const compared = plans.filter((p) => selected.includes(p.id))

  return (
    <div className="space-y-4">
      <PageHeader
        step="04 · 16–18"
        title={t('plans.title')}
        actions={
          <Button asChild variant="outline">
            <Link to="/simulator">{t('plans.goSim')}</Link>
          </Button>
        }
      />
      {plans.length === 0 ? (
        <Alert>{t('plans.empty')}</Alert>
      ) : (
        <>
          <p className="text-sm text-slate-700" data-testid="plans-total">
            {t('plans.total', { kwh: fmtKwh(totalKwh, lang), php: withPeso.length ? php(totalPhp, lang) : '—' })}
          </p>
          {plans.length > 1 && <p className="text-xs text-slate-500">{t('plans.totalNote')}</p>}
          <ul className="grid gap-3 md:grid-cols-2" data-testid="plans-list">
            {plans.map((p) => {
              const a = appliances.find((x) => x.id === p.applianceId)
              const stale = isPlanStale(p, a, rate)
              const r = p.result
              return (
                <li key={p.id} className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 size-5 accent-brand-700"
                      aria-label={`${t('plans.compare')}: ${p.applianceName}`}
                      checked={selected.includes(p.id)}
                      onChange={(e) => setSelected((s) => (e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id)))}
                    />
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="font-semibold">
                        {t('plans.change', {
                          name: p.applianceName,
                          from: num(p.baseline.hoursPerDay, lang),
                          fromDays: num(p.baseline.days, lang),
                          to: num(p.scenario.hoursPerDay, lang),
                          toDays: num(p.scenario.days, lang),
                        })}
                      </p>
                      <p className={r.direction === 'increase' ? 'text-red-700' : 'text-emerald-700'}>
                        {r.direction === 'increase' ? t('sim.increase') : r.direction === 'none' ? t('sim.noChange') : t('sim.saved')}:{' '}
                        <strong>{fmtKwh(Math.abs(r.savedKwh), lang)}</strong>
                        {r.savedPhp !== null && <> · <strong>{php(Math.abs(r.savedPhp), lang)}</strong></>} ({t('common.estimate')})
                      </p>
                      <p className="text-xs text-slate-500">
                        {p.rate ? `${php(p.rate.valuePhpPerKwh, lang)}/kWh · ${p.rate.month}` : t('sim.noRate')}
                      </p>
                      {p.goal && <p className="text-xs">{t('plans.goal', { goal: p.goal })}</p>}
                      <p className="text-xs text-slate-500">
                        {t('plans.created', { date: dateLabel(p.createdAt.slice(0, 10), lang) })}
                        {p.recalculatedAt && <Badge className="ml-2 border-sky-300 bg-sky-50 text-sky-800">{t('plans.recalculated', { date: dateLabel(p.recalculatedAt.slice(0, 10), lang) })}</Badge>}
                      </p>
                    </div>
                  </div>
                  {!a && <Alert tone="warning" className="text-xs">{t('plans.applianceGone')}</Alert>}
                  {stale && a && (
                    <Alert tone="warning" className="text-xs">
                      <p>{t('plans.stale')}</p>
                      <Button size="sm" variant="outline" className="mt-1" onClick={() => recalc(p, a)}>
                        <RefreshCw className="size-4" aria-hidden /> {t('plans.recalc')}
                      </Button>
                    </Alert>
                  )}
                  <div className="flex gap-2">
                    {a && (
                      <Button asChild size="sm" variant="outline">
                        <Link to={`/simulator?plan=${p.id}`}>
                          <Pencil className="size-4" aria-hidden /> {t('common.edit')}
                        </Link>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        if (!window.confirm(t('common.confirmDelete'))) return
                        await deletePlan(p.id)
                        setSelected((s) => s.filter((x) => x !== p.id))
                        toast(t('plans.deleted'))
                      }}
                    >
                      <Trash2 className="size-4" aria-hidden /> {t('common.delete')}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>

          <section aria-labelledby="compare-h" className="space-y-2">
            <h2 id="compare-h" className="font-semibold">{t('plans.compareTitle')}</h2>
            {compared.length < 2 ? (
              <p className="text-sm text-slate-500">{t('plans.compareHint')}</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left">
                    <tr>
                      <th className="p-2">{t('nav.appliances')}</th>
                      <th className="p-2">{t('sim.before')}</th>
                      <th className="p-2">{t('sim.after')}</th>
                      <th className="p-2">{t('sim.energyDiff')}</th>
                      <th className="p-2">{t('sim.pesoDiff')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compared.map((p) => (
                      <tr key={p.id} className="border-t">
                        <td className="p-2">{p.applianceName}</td>
                        <td className="p-2">{fmtKwh(p.result.baselineKwh, lang)}</td>
                        <td className="p-2">{fmtKwh(p.result.scenarioKwh, lang)}</td>
                        <td className="p-2">{fmtKwh(p.result.deltaKwh, lang)}</td>
                        <td className="p-2">{p.result.savedPhp === null ? '—' : php(-p.result.savedPhp, lang)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
