import { RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Decision } from '@/components/Decision'
import { PageHeader } from '@/components/PageHeader'
import { useToast } from '@/components/Toast'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Input, Select } from '@/components/ui/field'
import { useI18n, type TKey } from '@/i18n'
import { useData } from '@/lib/data'
import { periodDays } from '@/lib/dates'
import { compare, MAX_DAYS, usageOf } from '@/lib/energy'
import { kwh as fmtKwh, monthLabel, num, parseNumberInput, php } from '@/lib/format'
import type { CompareResult, Usage } from '@/lib/types'
import { VARIABLE_POWER } from '@/lib/validation'

type ScenarioDraft = Record<keyof Usage, string>
const toDraft = (u: Usage): ScenarioDraft => ({ wattage: String(u.wattage), hoursPerDay: String(u.hoursPerDay), days: String(u.days), quantity: String(u.quantity) })

export function validateScenario(d: ScenarioDraft, maxDays: number): { errors: Partial<Record<keyof Usage, TKey>>; usage: Usage | null } {
  const errors: Partial<Record<keyof Usage, TKey>> = {}
  const w = parseNumberInput(d.wattage)
  const h = parseNumberInput(d.hoursPerDay)
  const days = parseNumberInput(d.days)
  const q = parseNumberInput(d.quantity)
  if (w === null) errors.wattage = 'err.number'
  else if (w <= 0 || w > 10000) errors.wattage = 'err.positive'
  if (h === null) errors.hoursPerDay = 'err.number'
  else if (h < 0 || h > 24) errors.hoursPerDay = 'err.hours'
  if (days === null) errors.days = 'err.number'
  else if (days < 1 || days > maxDays) errors.days = 'err.days'
  if (q === null || !Number.isInteger(q) || q < 1 || q > 100) errors.quantity = 'err.wholePositive'
  return { errors, usage: Object.keys(errors).length ? null : { wattage: w!, hoursPerDay: h!, days: days!, quantity: q! } }
}

export default function Simulator() {
  const { t, lang } = useI18n()
  const nav = useNavigate()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const { appliances, plans, rate: currentRate, latest, savePlan, ready } = useData()
  const confirmed = appliances.filter((a) => a.confirmed)
  const planId = params.get('plan')
  const plan = planId ? plans.find((p) => p.id === planId) : undefined
  const applianceId = plan?.applianceId ?? params.get('appliance') ?? confirmed[0]?.id
  const appliance = confirmed.find((a) => a.id === applianceId)
  const maxDays = (latest && periodDays(latest.periodStart, latest.periodEnd)) || MAX_DAYS

  // Editing a plan keeps its original baseline and rate; a new scenario uses the confirmed appliance + current bill rate.
  const baseline: Usage | null = plan ? plan.baseline : appliance ? usageOf(appliance) : null
  const rate = plan ? plan.rate : currentRate
  const [draft, setDraft] = useState<ScenarioDraft | null>(null)
  const [stage, setStage] = useState<'explore' | 'save'>('explore')
  const [goal, setGoal] = useState('')
  const [saving, setSaving] = useState(false)
  const topRef = useRef<HTMLDivElement>(null)

  const baseKey = `${planId ?? ''}|${applianceId ?? ''}`
  useEffect(() => {
    if (plan) {
      setDraft(toDraft(plan.scenario))
      setGoal(plan.goal)
    } else if (baseline) {
      setDraft(toDraft(baseline))
      setGoal('')
    }
    setStage('explore')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey, ready])

  const { errors, usage } = useMemo(() => (draft ? validateScenario(draft, maxDays) : { errors: {}, usage: null }), [draft, maxDays])
  const result: CompareResult | null = useMemo(() => (baseline && usage ? compare(baseline, usage, rate?.valuePhpPerKwh ?? null) : null), [baseline, usage, rate])

  if (!ready) return <p role="status">{t('status.loading')}</p>
  if (confirmed.length === 0 && !plan)
    return (
      <div className="space-y-4">
        <PageHeader step="03 · 12" title={t('sim.title')} body={t('sim.body')} />
        <Alert tone="warning">{t('sim.none')}</Alert>
        <Button asChild>
          <Link to="/appliances">{t('sim.goAppliances')}</Link>
        </Button>
      </div>
    )
  if (!baseline || !draft) return <p role="status">{t('status.loading')}</p>

  const set = (k: keyof Usage, v: string) => setDraft({ ...draft, [k]: v })
  const reset = () => setDraft(toDraft(baseline))
  const tryAnother = () => {
    reset()
    setStage('explore')
    topRef.current?.scrollIntoView({ behavior: 'smooth' })
    topRef.current?.querySelector<HTMLElement>('select, input')?.focus()
  }

  const doSave = async () => {
    if (!result || !usage || saving) return
    setSaving(true)
    try {
      await savePlan(
        {
          applianceId: plan?.applianceId ?? appliance!.id,
          applianceName: plan?.applianceName ?? appliance!.name,
          baseline,
          scenario: usage,
          rate,
          result,
          goal: goal.trim().slice(0, 140),
        },
        plan?.id,
      )
      toast(t('sim.planSaved'))
      nav('/plans')
    } catch {
      toast(t('err.save'), 'error')
      setSaving(false)
    }
  }

  const name = plan?.applianceName ?? appliance?.name ?? ''
  const directionLabel = result?.direction === 'increase' ? t('sim.increase') : result?.direction === 'none' ? t('sim.noChange') : t('sim.saved')
  const tone = result?.direction === 'increase' ? 'text-red-700' : result?.direction === 'none' ? 'text-slate-700' : 'text-emerald-700'
  const sign = result?.direction === 'increase' ? '+' : result?.direction === 'decrease' ? '−' : ''
  const chartData = result ? [{ name: t('sim.before'), kWh: result.baselineKwh }, { name: t('sim.after'), kWh: result.scenarioKwh }] : []

  const numberField = (k: keyof Usage, label: string, extra?: { min: number; max: number; step: number }) => (
    <Field name={k} label={label} error={errors[k] ? t(errors[k]!) : undefined}>
      {({ id, describedBy, invalid }) => (
        <div className="space-y-1">
          <Input id={id} inputMode="decimal" value={draft[k]} aria-invalid={invalid} aria-describedby={describedBy} onChange={(e) => set(k, e.target.value)} />
          {extra && (
            <input
              type="range"
              aria-label={label}
              min={extra.min}
              max={extra.max}
              step={extra.step}
              value={parseNumberInput(draft[k]) ?? 0}
              onChange={(e) => set(k, e.target.value)}
              className="w-full accent-brand-700"
            />
          )}
        </div>
      )}
    </Field>
  )

  return (
    <div className="space-y-4" ref={topRef}>
      <PageHeader step="03 · 12–13" title={t('sim.title')} body={t('sim.body')} />
      {plan && <Alert>{t('sim.editingPlan')}</Alert>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="space-y-4 pt-4 sm:pt-5">
            {!plan && (
              <Field name="appliance" label={t('sim.pick')}>
                {({ id }) => (
                  <Select id={id} value={applianceId} onChange={(e) => setParams({ appliance: e.target.value })}>
                    {confirmed.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <div className="rounded-lg bg-slate-50 p-3 text-sm" data-testid="baseline">
              <p className="font-semibold">{t('sim.current')}: {name}</p>
              <p className="text-slate-600">
                {num(baseline.wattage, lang)} W × {baseline.quantity} · {num(baseline.hoursPerDay, lang)} {lang === 'fil' ? 'oras/araw' : 'h/day'} · {num(baseline.days, lang)} {lang === 'fil' ? 'araw' : 'days'}
              </p>
            </div>
            {appliance && VARIABLE_POWER.has(appliance.type) && <p className="text-xs text-amber-800">{t('appl.variable')}</p>}
            <h2 className="font-semibold">{t('sim.proposed')}</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {numberField('hoursPerDay', t('appl.hours'), { min: 0, max: 24, step: 0.5 })}
              {numberField('days', t('appl.days'), { min: 1, max: maxDays, step: 1 })}
              {numberField('quantity', t('appl.quantity'))}
              {numberField('wattage', t('appl.wattage'))}
            </div>
            <Button variant="outline" onClick={reset}>
              <RotateCcw className="size-4" aria-hidden /> {t('sim.reset')}
            </Button>
          </CardContent>
        </Card>

        <Card aria-live="polite">
          <CardHeader>
            <CardTitle>{t('sim.results')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!result ? (
              <Alert tone="warning">{t('sim.invalid')}</Alert>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-slate-500">{t('sim.before')}</p>
                    <p className="text-lg font-semibold" data-testid="before-kwh">{fmtKwh(result.baselineKwh, lang)}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-slate-500">{t('sim.after')}</p>
                    <p className="text-lg font-semibold" data-testid="after-kwh">{fmtKwh(result.scenarioKwh, lang)}</p>
                  </div>
                </div>
                <div className="rounded-lg border-2 border-brand-600/30 bg-brand-50 p-3">
                  <p className="text-sm font-semibold">{directionLabel} <span className="font-normal text-slate-500">({t('common.estimate')})</span></p>
                  {result.direction === 'none' ? (
                    <p className="text-sm text-slate-600">{t('sim.noChangeBody')}</p>
                  ) : (
                    <dl className="mt-1 grid grid-cols-2 gap-2">
                      <div>
                        <dt className="text-xs text-slate-500">{t('sim.energyDiff')}</dt>
                        <dd className={`text-xl font-bold ${tone}`} data-testid="delta-kwh">{sign}{fmtKwh(Math.abs(result.deltaKwh), lang)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-slate-500">{t('sim.pesoDiff')}</dt>
                        <dd className={`text-xl font-bold ${tone}`} data-testid="delta-php">{result.savedPhp === null ? '—' : `${sign}${php(Math.abs(result.savedPhp), lang)}`}</dd>
                      </div>
                    </dl>
                  )}
                </div>
                <div className="h-44" role="img" aria-label={`${t('sim.chart')}: ${t('sim.before')} ${result.baselineKwh} kWh, ${t('sim.after')} ${result.scenarioKwh} kWh`}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(v) => `${v} kWh`} />
                      <Bar dataKey="kWh" fill="#0f766e" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <ul className="space-y-1 text-xs text-slate-600">
                  {rate ? (
                    <li data-testid="rate-used">{t('sim.rateUsed', { rate: php(rate.valuePhpPerKwh, lang), label: t(`rate.label.${rate.source}` as TKey), month: monthLabel(rate.month, lang) })}</li>
                  ) : (
                    <li className="font-medium text-amber-800">{t('sim.noRate')}</li>
                  )}
                  <li>{t('sim.period', { days: num(usage!.days, lang) })}</li>
                  <li>{t('sim.assumptions')}</li>
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {result && stage === 'explore' && (
        <Decision step={15} question={t('sim.another')} yesLabel={t('sim.anotherYes')} noLabel={t('sim.anotherNo')} onYes={tryAnother} onNo={() => setStage('save')} />
      )}
      {result && stage === 'save' && (
        <Card>
          <CardContent className="space-y-3 pt-4 sm:pt-5">
            <Field name="goal" label={`${t('sim.goal')} (${t('common.optional')})`}>
              {({ id }) => <Input id={id} value={goal} maxLength={140} placeholder={t('sim.goalPlaceholder')} onChange={(e) => setGoal(e.target.value)} />}
            </Field>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={doSave} disabled={saving} className="sm:flex-1">
                {saving ? t('common.saving') : plan ? t('sim.updatePlan') : t('sim.savePlan')}
              </Button>
              <Button variant="outline" onClick={() => setStage('explore')} className="sm:flex-1">
                {t('common.back')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
