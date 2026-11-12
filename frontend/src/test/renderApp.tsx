import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppRoutes } from '@/App'
import { ToastProvider } from '@/components/Toast'
import { I18nProvider } from '@/i18n'
import { DataProvider } from '@/lib/data'
import { HealthProvider } from '@/lib/health'
import { LocalRepo } from '@/lib/storage/localRepo'
import { ProfileSync } from '@/components/ProfileSync'

const factory = async () => new LocalRepo()

export function renderApp(path = '/') {
  return render(
    <I18nProvider>
      <DataProvider repoFactory={factory}>
        <ProfileSync />
        <HealthProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={[path]}>
              <AppRoutes />
            </MemoryRouter>
          </ToastProvider>
        </HealthProvider>
      </DataProvider>
    </I18nProvider>,
  )
}
