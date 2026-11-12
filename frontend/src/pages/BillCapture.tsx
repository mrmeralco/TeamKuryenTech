import { Camera, ImageUp, Keyboard, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { useToast } from '@/components/Toast'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useI18n } from '@/i18n'
import { ApiError, isAcceptableImage, ocrBill } from '@/lib/api'
import { sortBills } from '@/lib/analytics'
import { useData } from '@/lib/data'
import { loadDraft, saveDraft } from '@/lib/drafts'
import { dateLabel, kwh, php } from '@/lib/format'
import { useOnline } from '@/lib/useOnline'
import { emptyBillDraft, type BillDraft } from '@/lib/validation'

export default function BillCapture() {
  const { t, lang } = useI18n()
  const nav = useNavigate()
  const online = useOnline()
  const toast = useToast()
  const { bills, deleteBill } = useData()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const pickRef = useRef<HTMLInputElement>(null)

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  const onPick = (f: File | undefined) => {
    setErr(null)
    if (!f) return
    if (!isAcceptableImage(f)) {
      setErr(t('bill.badFile'))
      return
    }
    setFile(f)
    setPreview(URL.createObjectURL(f))
  }

  const cancel = () => {
    setFile(null)
    setPreview(null)
    setErr(null)
    if (cameraRef.current) cameraRef.current.value = ''
    if (pickRef.current) pickRef.current.value = ''
  }

  const read = async () => {
    if (!file || busy) return
    setBusy(true)
    setErr(null)
    try {
      const r = await ocrBill(file)
      const f = r.fields
      const draft: BillDraft = {
        ...emptyBillDraft('ocr'),
        periodStart: f.periodStart ?? '',
        periodEnd: f.periodEnd ?? '',
        kwh: f.kwh === null ? '' : String(f.kwh),
        amountPhp: f.totalAmountPhp === null ? '' : String(f.totalAmountPhp),
        charges: f.charges ?? [],
        ocrMissing: Object.entries(r.fieldStatus ?? {}).filter(([, v]) => v === 'not_found').map(([k]) => (k === 'totalAmountPhp' ? 'amountPhp' : k)),
        ocrLowConfidence: !!r.lowConfidence,
      }
      saveDraft('bill', draft)
      cancel() // discard the photo on this device too
      nav('/bill/review')
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'network'
      setErr(
        code === 'offline' ? t('bill.ocrOffline')
        : code === 'ocr_unavailable' || code === 'network' || code === 'timeout' || code === 'server_error' ? t('bill.ocrUnavailable')
        : code === 'unsupported_type' ? t('bill.badFile')
        : t('bill.ocrFailed'),
      )
    } finally {
      setBusy(false)
    }
  }

  const manual = () => {
    const existing = loadDraft<BillDraft>('bill')
    saveDraft('bill', existing && !existing.id ? { ...existing, source: 'manual' } : emptyBillDraft('manual'))
    nav('/bill/review')
  }

  const sorted = sortBills(bills).reverse()

  return (
    <div className="space-y-5">
      <PageHeader step="01 · 3" title={t('bill.title')} body={t('bill.body')} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Camera className="size-5 text-brand-700" aria-hidden /> {t('bill.scan')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-slate-600">{t('bill.scanHint')}</p>
            {!online && <Alert tone="warning">{t('bill.ocrOffline')}</Alert>}
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => onPick(e.target.files?.[0])} />
            <input ref={pickRef} data-testid="bill-file" type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => onPick(e.target.files?.[0])} />
            {preview ? (
              <div className="space-y-3">
                <img src={preview} alt={t('bill.preview')} className="max-h-72 w-full rounded-lg border object-contain" />
                <div className="flex flex-wrap gap-2">
                  <Button onClick={read} disabled={busy || !online}>
                    {busy ? t('bill.reading') : t('bill.read')}
                  </Button>
                  <Button variant="outline" onClick={() => pickRef.current?.click()} disabled={busy}>
                    {t('bill.replace')}
                  </Button>
                  <Button variant="ghost" onClick={cancel} disabled={busy}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => cameraRef.current?.click()} disabled={!online}>
                  <Camera className="size-4" aria-hidden /> {t('bill.takePhoto')}
                </Button>
                <Button variant="outline" onClick={() => pickRef.current?.click()} disabled={!online}>
                  <ImageUp className="size-4" aria-hidden /> {t('bill.chooseFile')}
                </Button>
              </div>
            )}
            {err && (
              <Alert tone="error">
                <p>{err}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {file && online && (
                    <Button size="sm" variant="outline" onClick={read}>
                      {t('common.retry')}
                    </Button>
                  )}
                  <Button size="sm" onClick={manual}>
                    {t('bill.manual')}
                  </Button>
                </div>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Keyboard className="size-5 text-brand-700" aria-hidden /> {t('bill.manual')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-slate-600">{t('bill.manualHint')}</p>
            <Button variant="outline" onClick={manual}>
              {t('bill.manual')}
            </Button>
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="saved-bills" className="space-y-2">
        <h2 id="saved-bills" className="font-semibold">
          {t('bill.list')}
        </h2>
        {sorted.length === 0 ? (
          <p className="text-sm text-slate-500">{t('bill.none')}</p>
        ) : (
          <ul className="divide-y rounded-xl border border-slate-200 bg-white">
            {sorted.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {dateLabel(b.periodStart, lang)} – {dateLabel(b.periodEnd, lang)}
                  </p>
                  <p className="text-slate-600">
                    {kwh(b.kwh, lang)} · {php(b.amountPhp, lang)}
                  </p>
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link to={`/bill/${b.id}/edit`} aria-label={`${t('common.edit')} ${b.periodEnd}`}>
                    <Pencil className="size-4" aria-hidden /> {t('common.edit')}
                  </Link>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${t('common.delete')} ${b.periodEnd}`}
                  onClick={async () => {
                    if (!window.confirm(t('common.confirmDelete'))) return
                    await deleteBill(b.id)
                    toast(t('common.delete') + ' ✓')
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
