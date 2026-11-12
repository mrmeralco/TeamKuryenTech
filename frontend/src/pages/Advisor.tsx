import { Bot, Calculator, Send, User } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/field'
import { useI18n, type TKey } from '@/i18n'
import { changeVsPrevious } from '@/lib/analytics'
import { ApiError, askAdvisor, buildHousehold, type AdvisorToolCall, type AdvisorTurn } from '@/lib/api'
import { useData } from '@/lib/data'
import { safeApplianceKwh } from '@/lib/energy'
import { kwh as fmtKwh, php } from '@/lib/format'
import { useOnline } from '@/lib/useOnline'

interface Msg extends AdvisorTurn {
  toolCalls?: AdvisorToolCall[]
  unverified?: string[]
}

export default function Advisor() {
  const { t, lang } = useI18n()
  const online = useOnline()
  const { bills, appliances, rate, latest } = useData()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<null | 'unavailable' | 'error' | 'offline'>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const confirmed = appliances.filter((a) => a.confirmed)
  const facts = useMemo(() => {
    const ranked = confirmed.map((a) => ({ a, kwh: safeApplianceKwh(a) ?? 0 })).sort((x, y) => y.kwh - x.kwh)
    const missing: TKey[] = []
    if (!bills.length) missing.push('adv.missingBill')
    if (!confirmed.length) missing.push('adv.missingAppl')
    if (!rate) missing.push('adv.missingRate')
    return { top: ranked[0], change: changeVsPrevious(bills), missing }
  }, [bills, confirmed, rate])

  const send = async (text: string) => {
    const message = text.trim().slice(0, 800)
    if (!message || busy) return
    if (!online) {
      setStatus('offline')
      return
    }
    setStatus(null)
    setBusy(true)
    const history = msgs.slice(-8).map(({ role, text }) => ({ role, text: text.slice(0, 2000) }))
    setMsgs((m) => [...m, { role: 'user', text: message }])
    setInput('')
    try {
      const r = await askAdvisor({ message, language: lang, history, household: buildHousehold(bills, appliances, rate) })
      setMsgs((m) => [...m, { role: 'assistant', text: r.reply, toolCalls: r.toolCalls, unverified: r.unverifiedFigures }])
    } catch (e) {
      // Never invent a reply. Remove nothing; show an honest status instead.
      const code = e instanceof ApiError ? e.code : 'network'
      setStatus(code === 'offline' ? 'offline' : code === 'ai_unavailable' || code === 'network' || code === 'timeout' ? 'unavailable' : 'error')
    } finally {
      setBusy(false)
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }))
    }
  }

  const suggestions: TKey[] = ['adv.suggest1', 'adv.suggest2', 'adv.suggest3', 'adv.suggest4']

  return (
    <div className="space-y-4">
      <PageHeader step="03 · 14" title={t('adv.title')} body={t('adv.body')} />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="flex min-h-[420px] flex-col">
          <CardContent className="flex flex-1 flex-col gap-3 pt-4 sm:pt-5">
            <div className="flex-1 space-y-3" aria-live="polite" data-testid="chat-log">
              {msgs.length === 0 && (
                <div className="flex flex-wrap gap-2">
                  {suggestions.map((k) => (
                    <Button key={k} size="sm" variant="outline" onClick={() => send(t(k))} disabled={busy} className="h-auto py-2 whitespace-normal">
                      {t(k)}
                    </Button>
                  ))}
                </div>
              )}
              {msgs.map((m, i) => (
                <div key={i} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : ''}`}>
                  {m.role === 'assistant' && <Bot className="mt-1 size-5 shrink-0 text-brand-700" aria-hidden />}
                  <div className={`max-w-[85%] space-y-2 rounded-xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-brand-700 text-white' : 'bg-slate-100'}`}>
                    <p className="sr-only">{m.role === 'user' ? t('adv.you') : t('adv.bot')}:</p>
                    <p className="whitespace-pre-wrap">{m.text}</p>
                    {m.toolCalls?.map((c, j) =>
                      'error' in c.result ? null : (
                        <p key={j} className="flex items-start gap-1 rounded bg-white px-2 py-1 text-xs text-slate-700">
                          <Calculator className="mt-0.5 size-3.5 shrink-0 text-brand-700" aria-hidden />
                          <span>
                            {t('adv.calcUsed')}: {c.result.appliance} {c.result.baseline.hoursPerDay}→{c.result.scenario.hoursPerDay} h/day:{' '}
                            {fmtKwh(c.result.savedKwh, lang)}
                            {c.result.savedPhp !== null && ` · ${php(c.result.savedPhp, lang)}`}
                          </span>
                        </p>
                      ),
                    )}
                    {m.unverified && m.unverified.length > 0 && (
                      <Alert tone="warning" className="text-xs">{t('adv.unverified', { figs: m.unverified.join(', ') })}</Alert>
                    )}
                  </div>
                  {m.role === 'user' && <User className="mt-1 size-5 shrink-0 text-slate-400" aria-hidden />}
                </div>
              ))}
              {busy && <p role="status" className="text-sm text-slate-500">{t('adv.thinking')}</p>}
              {status && (
                <Alert tone={status === 'error' ? 'error' : 'warning'} role="alert">
                  {t(status === 'offline' ? 'adv.offline' : status === 'unavailable' ? 'adv.unavailable' : 'adv.error')}
                </Alert>
              )}
              <div ref={endRef} />
            </div>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void send(input)
              }}
            >
              <label htmlFor="adv-input" className="sr-only">{t('adv.placeholder')}</label>
              <Textarea
                id="adv-input"
                rows={2}
                maxLength={800}
                value={input}
                placeholder={t('adv.placeholder')}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send(input)
                  }
                }}
              />
              <Button type="submit" disabled={busy || !input.trim()} aria-label={t('adv.send')}>
                <Send className="size-4" aria-hidden />
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t('adv.facts')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm" data-testid="advisor-facts">
            {latest && <p>{t('adv.latestBill', { kwh: fmtKwh(latest.kwh, lang), amount: php(latest.amountPhp, lang) })}</p>}
            {facts.change && (
              <p>
                {t('adv.changeVsPrev', {
                  kwh: `${facts.change.kwh > 0 ? '+' : ''}${fmtKwh(facts.change.kwh, lang)}`,
                  amount: `${facts.change.amountPhp > 0 ? '+' : ''}${php(facts.change.amountPhp, lang)}`,
                })}
              </p>
            )}
            {facts.top && <p>{t('adv.topEstimate', { name: facts.top.a.name, kwh: fmtKwh(facts.top.kwh, lang) })}</p>}
            {facts.missing.length > 0 && (
              <Alert tone="warning">{t('adv.missing', { items: facts.missing.map((k) => t(k)).join('; ') })}</Alert>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
