import { useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { useToast } from '@/components/Toast'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useI18n, type TKey } from '@/i18n'
import { useData } from '@/lib/data'
import { clearDraft } from '@/lib/drafts'
import { useHealth } from '@/lib/health'

export default function Settings() {
  const { t, lang, setLang } = useI18n()
  const toast = useToast()
  const health = useHealth()
  const { mode, repo, clearAll } = useData()
  const [linkState, setLinkState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const status = (b: boolean | undefined): string => (health.status === 'checking' ? t('set.unknown') : b ? t('set.on') : t('set.off'))
  const h = health.status === 'ok' ? health.health : undefined

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title={t('set.title')} />
      <Card>
        <CardHeader><CardTitle>{t('set.language')}</CardTitle></CardHeader>
        <CardContent className="flex gap-2">
          {(['en', 'fil'] as const).map((l) => (
            <Button key={l} variant={lang === l ? 'default' : 'outline'} aria-pressed={lang === l} onClick={() => setLang(l)}>
              {t(l === 'en' ? 'lang.en' : 'lang.fil')}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('set.storage')}</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p data-testid="storage-mode">{t(mode === 'local' ? 'set.storage.local' : 'set.storage.firestore')}</p>
          {mode === 'firestore' && repo?.isAnonymous && (
            <>
              <p className="text-slate-600">{t('set.anonNote')}</p>
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await repo.upgradeAccount?.()
                    setLinkState('ok')
                  } catch {
                    setLinkState('fail')
                  }
                }}
              >
                {t('set.upgrade')}
              </Button>
            </>
          )}
          {linkState === 'ok' && <Alert tone="success">{t('set.upgraded')}</Alert>}
          {linkState === 'fail' && <Alert tone="error">{t('set.upgradeFailed')}</Alert>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('set.services')}</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm" data-testid="services">
          <p>{t('set.ocr', { status: status(h?.ocrAvailable) })}</p>
          <p>{t('set.ai', { status: status(h?.aiAvailable) })}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('set.privacy')}</CardTitle></CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            {(['set.privacy.1', 'set.privacy.2', 'set.privacy.3', 'set.privacy.4'] as TKey[]).map((k) => <li key={k}>{t(k)}</li>)}
          </ul>
        </CardContent>
      </Card>

      <Button
        variant="destructive"
        onClick={async () => {
          if (!window.confirm(t('set.deleteConfirm'))) return
          await clearAll()
          ;['bill', 'appliance'].forEach(clearDraft)
          toast(t('set.deleted'))
        }}
      >
        {t('set.delete')}
      </Button>
    </div>
  )
}
