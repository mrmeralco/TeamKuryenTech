import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { useI18n, type Lang } from '@/i18n'
import { cn } from '@/lib/utils'

export default function Language() {
  const { t, lang, setLang } = useI18n()
  const nav = useNavigate()
  const choose = (l: Lang) => {
    setLang(l)
    nav('/bill')
  }
  return (
    <div className="mx-auto max-w-md">
      <PageHeader step="01 · 2" title={t('lang.title')} body={t('lang.body')} />
      <div className="grid gap-3">
        {(['en', 'fil'] as const).map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => choose(l)}
            className={cn(
              'min-h-16 rounded-xl border-2 bg-white px-4 text-left text-lg font-semibold hover:border-brand-600',
              lang === l ? 'border-brand-700' : 'border-slate-200',
            )}
          >
            {t(l === 'en' ? 'lang.en' : 'lang.fil')}
          </button>
        ))}
      </div>
    </div>
  )
}
