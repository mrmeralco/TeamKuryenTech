import { lazy, Suspense } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Layout } from './components/Layout'
import { ProfileSync } from './components/ProfileSync'
import { ToastProvider } from './components/Toast'
import { I18nProvider, useI18n } from './i18n'
import { DataProvider } from './lib/data'
import { HealthProvider } from './lib/health'
import Welcome from './pages/Welcome'

const Language = lazy(() => import('./pages/Language'))
const BillCapture = lazy(() => import('./pages/BillCapture'))
const BillReview = lazy(() => import('./pages/BillReview'))
const Appliances = lazy(() => import('./pages/Appliances'))
const ApplianceForm = lazy(() => import('./pages/ApplianceForm'))
const Simulator = lazy(() => import('./pages/Simulator'))
const Advisor = lazy(() => import('./pages/Advisor'))
const Plans = lazy(() => import('./pages/Plans'))
const Analytics = lazy(() => import('./pages/Analytics'))
const More = lazy(() => import('./pages/More'))
const Settings = lazy(() => import('./pages/Settings'))

function NotFound() {
  const { t } = useI18n()
  return (
    <div className="space-y-2 py-10 text-center">
      <p>{t('err.notFound')}</p>
      <Link to="/" className="text-brand-700 underline">{t('nav.home')}</Link>
    </div>
  )
}

export function AppRoutes() {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-center text-sm text-slate-500">…</p>}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Welcome />} />
          <Route path="language" element={<Language />} />
          <Route path="bill" element={<BillCapture />} />
          <Route path="bill/review" element={<BillReview />} />
          <Route path="bill/:id/edit" element={<BillReview />} />
          <Route path="appliances" element={<Appliances />} />
          <Route path="appliances/new" element={<ApplianceForm />} />
          <Route path="appliances/:id/edit" element={<ApplianceForm />} />
          <Route path="simulator" element={<Simulator />} />
          <Route path="advisor" element={<Advisor />} />
          <Route path="plans" element={<Plans />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="more" element={<More />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <I18nProvider>
        <DataProvider>
          <ProfileSync />
          <HealthProvider>
            <ToastProvider>
              <BrowserRouter>
                <AppRoutes />
              </BrowserRouter>
            </ToastProvider>
          </HealthProvider>
        </DataProvider>
      </I18nProvider>
    </ErrorBoundary>
  )
}
