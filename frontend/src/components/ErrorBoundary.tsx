import { Component, type ReactNode } from 'react'
import { translate, readStoredLang } from '@/i18n'

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.error('UI error', error)
  }
  render() {
    if (!this.state.failed) return this.props.children
    const lang = readStoredLang() ?? 'en'
    return (
      <div role="alert" className="mx-auto max-w-md space-y-3 p-6 text-center">
        <p className="font-semibold">{translate(lang, 'err.crash')}</p>
        <button type="button" className="rounded-lg bg-brand-700 px-4 py-2 text-white" onClick={() => window.location.reload()}>
          {translate(lang, 'err.reload')}
        </button>
      </div>
    )
  }
}
