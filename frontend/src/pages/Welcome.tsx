import { Calculator, ClipboardList, FileText, Plug, Zap } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useI18n } from '@/i18n'
import { useData } from '@/lib/data'
import { clearDraft } from '@/lib/drafts'

export function nextStepPath(d: { bills: unknown[]; appliances: { confirmed: boolean }[]; plans: unknown[] }) {
  if (d.bills.length === 0) return '/bill'
  if (!d.appliances.some((a) => a.confirmed)) return '/appliances'
  if (d.plans.length === 0) return '/simulator'
  return '/analytics'
}

export default function Welcome() {
  const { t, hasChosen } = useI18n()
  const data = useData()
  const nav = useNavigate()
  const returning = data.bills.length + data.appliances.length + data.plans.length > 0

  const startNew = async () => {
    if (!window.confirm(t('welcome.newConfirm'))) return
    await data.clearAll()
    ;['bill', 'appliance'].forEach(clearDraft)
    nav(hasChosen ? '/bill' : '/language')
  }

  const steps = [
    { icon: FileText, k: 'welcome.how1' as const },
    { icon: Plug, k: 'welcome.how2' as const },
    { icon: Calculator, k: 'welcome.how3' as const },
    { icon: ClipboardList, k: 'welcome.how4' as const },
  ]

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-4">
      <div className="space-y-3 text-center">
        <span className="mx-auto grid size-16 place-items-center rounded-2xl bg-brand-700 text-sun shadow">
          <Zap className="size-9" aria-hidden fill="currentColor" />
        </span>
        <p className="text-sm font-semibold text-brand-700">{t('app.tagline')}</p>
        <h1 className="text-3xl font-bold text-balance text-slate-900">{t('welcome.title')}</h1>
        <p className="text-slate-600">{t('welcome.body')}</p>
      </div>

      {!data.ready ? (
        <p role="status" className="text-center text-sm text-slate-500">
          {t('status.loading')}
        </p>
      ) : returning ? (
        <Card>
          <CardContent className="space-y-3 pt-4 sm:pt-5">
            <Alert tone="success">
              <p className="font-medium">{t('welcome.returning')}</p>
              <p>{t('welcome.summary', { bills: data.bills.length, appliances: data.appliances.length, plans: data.plans.length })}</p>
            </Alert>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button size="lg" className="sm:flex-1" onClick={() => nav(nextStepPath(data))}>
                {t('welcome.continue')}
              </Button>
              <Button size="lg" variant="outline" className="sm:flex-1" onClick={startNew}>
                {t('welcome.new')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="flex justify-center">
          <Button size="lg" className="w-full sm:w-auto sm:min-w-48" onClick={() => nav('/language')}>
            {t('welcome.start')}
          </Button>
        </div>
      )}

      <ol className="grid gap-3 sm:grid-cols-2">
        {steps.map((s, i) => (
          <li key={s.k} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
              <s.icon className="size-5" aria-hidden />
            </span>
            <span className="text-sm">
              <span className="font-semibold text-slate-500">{i + 1}. </span>
              {t(s.k)}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-center text-xs text-slate-500">{t('welcome.disclaimer')}</p>
    </div>
  )
}
