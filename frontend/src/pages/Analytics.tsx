import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { PageHeader } from '@/components/PageHeader'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useI18n, type TKey } from '@/i18n'
import { aggregateBills, changeVsPrevious, type Granularity } from '@/lib/analytics'
import { useData } from '@/lib/data'
import { round2, safeApplianceKwh } from '@/lib/energy'
import { kwh as fmtKwh, monthLabel, php } from '@/lib/format'
import { cn } from '@/lib/utils'

const GRANULARITIES: Granularity[] = ['monthly', 'quarterly', 'yearly', 'seasonal']

export default function Analytics() {
  const { t, lang } = useI18n()
  const { bills, appliances, plans, latest, ready } = useData()
  const [g, setG] = useState<Granularity>('monthly')
  if (!ready) return <p role="status">{t('status.loading')}</p>

  const label = (key: string) => {
    if (g === 'monthly') return monthLabel(key, lang)
    if (g === 'seasonal') {
      const [y, s] = key.split(/-(.+)/)
      return `${t(`an.season.${s}` as TKey)} ${y}`
    }
    return key
  }
  const buckets = aggregateBills(bills, g).map((b) => ({ ...b, label: label(b.key) }))
  const change = changeVsPrevious(bills)
  const est = appliances
    .filter((a) => a.confirmed)
    .map((a) => ({ name: a.name, kWh: safeApplianceKwh(a) ?? 0 }))
    .sort((a, b) => b.kWh - a.kWh)
  const estTotal = round2(est.reduce((s, x) => s + x.kWh, 0))
  const savings = plans.filter((p) => p.result.direction === 'decrease').sort((a, b) => b.result.savedKwh - a.result.savedKwh)

  return (
    <div className="space-y-4">
      <PageHeader step="04 · 17" title={t('an.title')} />

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>{t('an.billed')}</CardTitle>
          <div role="group" aria-label={t('an.period')} className="flex flex-wrap gap-1">
            {GRANULARITIES.map((x) => (
              <button
                key={x}
                type="button"
                aria-pressed={g === x}
                onClick={() => setG(x)}
                className={cn('min-h-9 rounded-md border px-3 text-xs font-medium', g === x ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white')}
              >
                {t(`an.${x}` as TKey)}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {bills.length === 0 ? (
            <Alert>
              {t('an.noBills')}{' '}
              <Link to="/bill" className="font-medium underline">{t('nav.bill')}</Link>
            </Alert>
          ) : (
            <>
              {bills.length === 1 && <Alert>{t('an.oneBill')}</Alert>}
              {change && (
                <p className="text-sm" data-testid="bill-change">
                  {t('an.change', {
                    kwh: `${change.kwh > 0 ? '+' : ''}${fmtKwh(change.kwh, lang)}`,
                    pct: change.pctKwh === null ? '—' : `${change.pctKwh > 0 ? '+' : ''}${change.pctKwh}%`,
                    php: `${change.amountPhp > 0 ? '+' : ''}${php(change.amountPhp, lang)}`,
                  })}
                </p>
              )}
              {bills.length > 1 && (
                <div className="grid gap-4 md:grid-cols-2">
                  {(['kwh', 'amountPhp'] as const).map((k) => (
                    <div key={k} className="h-56" role="img" aria-label={t(k === 'kwh' ? 'an.billedKwh' : 'an.billedAmount')}>
                      <p className="mb-1 text-xs font-medium text-slate-600">{t(k === 'kwh' ? 'an.billedKwh' : 'an.billedAmount')}</p>
                      <ResponsiveContainer width="100%" height="90%">
                        <BarChart data={buckets} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                          <YAxis tick={{ fontSize: 11 }} />
                          <Tooltip />
                          <Bar dataKey={k} name={t(k === 'kwh' ? 'an.billedKwh' : 'an.billedAmount')} fill={k === 'kwh' ? '#0f766e' : '#0369a1'} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ))}
                </div>
              )}
              {g === 'seasonal' && <p className="text-xs text-slate-600">{t('an.seasonNote')}</p>}
              <details>
                <summary className="cursor-pointer text-sm font-medium">{t('an.table')}</summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-sm" data-testid="trend-table">
                    <thead className="text-left text-slate-600">
                      <tr><th className="p-1">{t('an.period')}</th><th className="p-1">kWh</th><th className="p-1">₱</th><th className="p-1">{t('an.bills')}</th></tr>
                    </thead>
                    <tbody>
                      {buckets.map((b) => (
                        <tr key={b.key} className="border-t"><td className="p-1">{b.label}</td><td className="p-1">{fmtKwh(b.kwh, lang)}</td><td className="p-1">{php(b.amountPhp, lang)}</td><td className="p-1">{b.bills}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('an.estimated')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {est.length === 0 ? (
            <Alert>{t('an.noAppliances')}</Alert>
          ) : (
            <>
              <div style={{ height: Math.max(120, est.length * 36) }} role="img" aria-label={t('an.estimated')}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={est} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 8 }}>
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => `${v} kWh`} />
                    <Bar dataKey="kWh" isAnimationActive={false} radius={[0, 4, 4, 0]}>
                      {est.map((_, i) => <Cell key={i} fill="#94a3b8" />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {latest && <p className="text-xs text-slate-600">{t('an.estimatedNote', { est: fmtKwh(estTotal, lang), billed: fmtKwh(latest.kwh, lang) })}</p>}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('an.opportunities')}</CardTitle>
        </CardHeader>
        <CardContent>
          {savings.length === 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-slate-500">{t('plans.empty')}</p>
              <Button asChild size="sm" variant="outline"><Link to="/simulator">{t('plans.goSim')}</Link></Button>
            </div>
          ) : (
            <ul className="space-y-1 text-sm" data-testid="opportunities">
              {savings.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 border-b py-1 last:border-0">
                  <span>{p.applianceName}: {p.baseline.hoursPerDay}→{p.scenario.hoursPerDay} h/day</span>
                  <span className="font-medium text-emerald-700">
                    {fmtKwh(p.result.savedKwh, lang)}{p.result.savedPhp !== null && ` · ${php(p.result.savedPhp, lang)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
