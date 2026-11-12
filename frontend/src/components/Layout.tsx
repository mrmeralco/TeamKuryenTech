import { BarChart3, Calculator, ClipboardList, FileText, MessageCircle, Plug, Settings, Zap } from 'lucide-react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useI18n, type TKey } from '@/i18n'
import { useData } from '@/lib/data'
import { useOnline } from '@/lib/useOnline'
import { cn } from '@/lib/utils'

const NAV: Array<{ to: string; key: TKey; icon: typeof Zap; section: 1 | 2 | 3 | 4 }> = [
  { to: '/bill', key: 'nav.bill', icon: FileText, section: 1 },
  { to: '/appliances', key: 'nav.appliances', icon: Plug, section: 2 },
  { to: '/simulator', key: 'nav.simulator', icon: Calculator, section: 3 },
  { to: '/advisor', key: 'nav.advisor', icon: MessageCircle, section: 3 },
  { to: '/plans', key: 'nav.plans', icon: ClipboardList, section: 4 },
  { to: '/analytics', key: 'nav.analytics', icon: BarChart3, section: 4 },
]

function sectionFor(path: string): number {
  if (path.startsWith('/bill') || path.startsWith('/language')) return 1
  if (path.startsWith('/appliances')) return 2
  if (path.startsWith('/simulator') || path.startsWith('/advisor')) return 3
  if (path.startsWith('/plans') || path.startsWith('/analytics') || path.startsWith('/more')) return 4
  return 0
}

export function Layout() {
  const { t, lang, setLang } = useI18n()
  const { pathname } = useLocation()
  const online = useOnline()
  const { sync, error, bills, appliances, plans } = useData()
  const current = sectionFor(pathname)
  const done = [bills.length > 0, appliances.some((a) => a.confirmed), plans.length > 0, false]

  return (
    <div className="min-h-dvh pb-20 md:pb-0">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2">
          <Link to="/" className="flex items-center gap-2 font-bold text-brand-800" aria-label={`${t('app.name')} — ${t('nav.home')}`}>
            <span className="grid size-8 place-items-center rounded-lg bg-brand-700 text-sun">
              <Zap className="size-5" aria-hidden fill="currentColor" />
            </span>
            <span>{t('app.name')}</span>
          </Link>
          <nav aria-label={t('nav.main')} className="ml-4 hidden gap-1 md:flex">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  cn('rounded-md px-3 py-2 text-sm font-medium', isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-slate-100')
                }
              >
                {t(n.key)}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <div role="group" aria-label={t('set.language')} className="flex rounded-md border border-slate-300 p-0.5 text-xs font-semibold">
              {(['en', 'fil'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLang(l)}
                  aria-pressed={lang === l}
                  className={cn('min-h-8 rounded px-2', lang === l ? 'bg-brand-700 text-white' : 'text-slate-700')}
                >
                  {l === 'en' ? 'EN' : 'FIL'}
                </button>
              ))}
            </div>
            <NavLink to="/settings" aria-label={t('nav.settings')} className="grid size-10 place-items-center rounded-md text-slate-600 hover:bg-slate-100">
              <Settings className="size-5" aria-hidden />
            </NavLink>
          </div>
        </div>
        {current > 0 && (
          <ol aria-label={t('section.progress')} className="mx-auto flex max-w-5xl gap-1 px-4 pb-2 text-[11px] sm:text-xs">
            {[1, 2, 3, 4].map((s) => (
              <li
                key={s}
                aria-current={s === current ? 'step' : undefined}
                className={cn(
                  'flex-1 truncate rounded px-2 py-1 font-medium',
                  s === current ? 'bg-brand-700 text-white' : done[s - 1] ? 'bg-brand-100 text-brand-900' : 'bg-slate-100 text-slate-500',
                )}
              >
                {String(s).padStart(2, '0')} {t(`section.${s}` as TKey)}
                {done[s - 1] && s !== current ? ' ✓' : ''}
              </li>
            ))}
          </ol>
        )}
      </header>

      {!online && (
        <div role="status" className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-950">
          {t('status.offline')}
        </div>
      )}
      {error && (
        <div role="alert" className="bg-red-100 px-4 py-2 text-center text-sm text-red-900">
          {t('status.storageError')}
        </div>
      )}

      <main id="main" className="mx-auto max-w-5xl px-4 py-5">
        <Outlet />
      </main>

      <footer className="mx-auto max-w-5xl px-4 pb-6 text-xs text-slate-500">
        <span data-testid="sync-status">{t(sync === 'local-only' ? 'status.local' : sync === 'pending' ? 'status.pending' : 'status.synced')}</span>
        {' · '}
        <Link to="/more" className="underline">
          {t('nav.more')}
        </Link>
      </footer>

      <nav aria-label={t('nav.main')} className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 border-t border-slate-200 bg-white md:hidden">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            className={({ isActive }) =>
              cn('flex min-h-14 flex-col items-center justify-center gap-0.5 text-[10px] font-medium', isActive ? 'text-brand-700' : 'text-slate-500')
            }
          >
            <n.icon className="size-5" aria-hidden />
            <span className="max-w-full truncate px-0.5">{t(n.key)}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
