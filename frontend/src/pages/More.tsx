import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { Alert, Badge } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { TIERS } from '@/config/tiers'
import { useI18n } from '@/i18n'
import { nextStepPath } from './Welcome'
import { useData } from '@/lib/data'

export default function More() {
  const { t } = useI18n()
  const nav = useNavigate()
  const data = useData()
  return (
    <div className="space-y-4">
      <PageHeader step="04 · 19" title={t('more.title')} body={t('more.body')} />
      <Alert>{t('more.notice')}</Alert>
      <ul className="grid gap-3 md:grid-cols-2">
        {TIERS.map((tier) => (
          <li key={tier.id} className={`rounded-xl border p-4 ${tier.available ? 'border-brand-600 bg-white' : 'border-dashed border-slate-300 bg-slate-50'}`}>
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-semibold">{t(tier.title)}</h2>
              <Badge className={tier.available ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-slate-300 bg-white text-slate-600'}>
                {tier.available ? t('more.available') : t('more.status')}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-slate-600">{t(tier.body)}</p>
          </li>
        ))}
      </ul>
      <section className="rounded-xl bg-brand-700 p-4 text-white">
        <p className="text-xs font-semibold tracking-wide uppercase opacity-80">04 · 20</p>
        <Button variant="outline" className="mt-2 w-full sm:w-auto" onClick={() => nav(nextStepPath(data) === '/analytics' ? '/plans' : nextStepPath(data))}>
          {t('more.no')}
        </Button>
        <p className="mt-3 text-sm font-medium">{t('app.end')}</p>
      </section>
    </div>
  )
}
