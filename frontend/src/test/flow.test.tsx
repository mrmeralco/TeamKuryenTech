import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_KEY } from '@/lib/storage/localRepo'
import { renderApp } from './renderApp'

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const { status, body } = handler(String(input), init)
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  })
}

const stored = () => JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}')

async function enterBill(user: ReturnType<typeof userEvent.setup>, rate: RegExp = /proposal reference rate/i) {
  await user.click(await screen.findByRole('button', { name: /enter bill details manually/i }))
  await screen.findByRole('heading', { name: /review & confirm bill details/i })
  await user.type(screen.getByLabelText(/billing period start/i), '2026-09-15')
  await user.type(screen.getByLabelText(/billing period end/i), '2026-10-14')
  await user.type(screen.getByLabelText(/total consumption/i), '280')
  await user.type(screen.getByLabelText(/total amount due/i), '3500')
  await user.click(screen.getByRole('radio', { name: rate }))
  await user.click(screen.getByRole('button', { name: /yes, save bill/i }))
}

describe('SmartWatts user journey (integration, local storage mode)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockFetch((url) => (url.endsWith('/health') ? { status: 200, body: { status: 'ok', ocrAvailable: true, aiAvailable: false } } : { status: 503, body: { detail: { code: 'ai_unavailable', message: 'x' } } }))
  })

  it('steps 1→16: bill, appliance, simulate 8h→6h = 3.9 kWh / ₱48.48, save plan, data persists', async () => {
    const user = userEvent.setup()
    const view = renderApp('/')
    await user.click(await screen.findByRole('button', { name: /^start$/i }))
    await user.click(await screen.findByRole('button', { name: 'English' }))
    await enterBill(user)

    // Step 6 -> 7
    await screen.findByRole('heading', { name: /your appliances/i })
    expect(Object.values(stored().bills)).toHaveLength(1)
    expect(Object.values(stored().bills)[0]).toMatchObject({ kwh: 280, amountPhp: 3500, rate: { valuePhpPerKwh: 12.43, source: 'reference' } })

    await user.click(screen.getByRole('link', { name: /add appliance/i }))
    await user.selectOptions(await screen.findByLabelText(/appliance type/i), 'fan')
    await user.type(screen.getByLabelText(/rated power/i), '65')
    await user.type(screen.getByLabelText(/hours used per day/i), '8')
    expect(screen.getByLabelText(/days used/i)).toHaveValue('30')
    expect(screen.getByTestId('appliance-preview')).toHaveTextContent('15.6 kWh')
    await user.click(screen.getByRole('button', { name: /save appliance/i }))

    // Step 9/10/11
    const list = await screen.findByRole('list', { name: /your appliances/i })
    expect(within(list).getByText('Electric fan', { selector: 'p.font-semibold' })).toBeInTheDocument()
    expect(within(list).getByText(/not yet confirmed/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /yes, save appliance list/i }))

    // Step 12/13
    await screen.findByRole('heading', { name: /what-if savings simulator/i })
    expect(screen.getByTestId('before-kwh')).toHaveTextContent('15.6 kWh')
    const hours = screen.getByRole('textbox', { name: /hours used per day/i })
    await user.clear(hours)
    await user.type(hours, '6')
    expect(screen.getByTestId('after-kwh')).toHaveTextContent('11.7 kWh')
    expect(screen.getByTestId('delta-kwh')).toHaveTextContent('−3.9 kWh')
    expect(screen.getByTestId('delta-php')).toHaveTextContent('₱48.48')
    expect(screen.getByTestId('rate-used')).toHaveTextContent(/12\.43/)

    // Baseline untouched while experimenting
    expect(Object.values(stored().appliances)[0]).toMatchObject({ hoursPerDay: 8, confirmed: true })

    // Step 15: Yes resets; No -> save
    await user.click(screen.getByRole('button', { name: /yes, try another/i }))
    expect(screen.getByTestId('after-kwh')).toHaveTextContent('15.6 kWh')
    await user.clear(hours)
    await user.type(hours, '6')
    await user.click(screen.getByRole('button', { name: /no, save this plan/i }))
    await user.type(screen.getByLabelText(/personal goal/i), 'Off at midnight')
    await user.click(screen.getByRole('button', { name: /save savings plan/i }))

    // Step 16/18
    await screen.findByRole('heading', { name: /saved savings plans/i })
    expect(screen.getByTestId('plans-list')).toHaveTextContent('₱48.48')
    const plans = Object.values(stored().plans) as Array<Record<string, unknown>>
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ goal: 'Off at midnight', result: { savedKwh: 3.9, savedPhp: 48.48 } })

    // "Refresh": unmount and render again from storage
    view.unmount()
    renderApp('/plans')
    expect(await screen.findByTestId('plans-list')).toHaveTextContent('3.9 kWh')
  })

  it('step 5 "No" path: invalid values are highlighted and focused; retake/manual options shown', async () => {
    const user = userEvent.setup()
    renderApp('/bill')
    await user.click(await screen.findByRole('button', { name: /enter bill details manually/i }))
    await user.type(await screen.findByLabelText(/total consumption/i), '-5')
    await user.click(screen.getByRole('button', { name: /yes, save bill/i }))
    expect(await screen.findByText(/please fix the highlighted fields/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/total consumption/i)).toHaveAttribute('aria-invalid', 'true')
    await waitFor(() => expect(screen.getByLabelText(/billing period start/i)).toHaveFocus())
    expect(screen.getByRole('button', { name: /retake photo/i })).toBeInTheDocument()
    expect(Object.values(stored().bills ?? {})).toHaveLength(0)
  })

  it('OCR result goes to editable review and is never auto-saved; photo-read failures fall back to manual', async () => {
    vi.restoreAllMocks()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let fail = true
    mockFetch((url) => {
      if (url.endsWith('/health')) return { status: 200, body: { status: 'ok', ocrAvailable: true, aiAvailable: false } }
      if (fail) return { status: 503, body: { detail: { code: 'ocr_unavailable', message: 'x' } } }
      return { status: 200, body: { fields: { periodStart: '2026-09-15', periodEnd: '2026-10-14', kwh: 280, totalAmountPhp: null, charges: [{ key: 'generation', amountPhp: 1620.4 }] }, fieldStatus: { periodStart: 'read', periodEnd: 'read', kwh: 'read', totalAmountPhp: 'not_found' }, confidence: 55, lowConfidence: true, warnings: ['Could not read the total amount.'] } }
    })
    const user = userEvent.setup()
    renderApp('/bill')
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'bill.png', { type: 'image/png' })
    await user.upload(await screen.findByTestId('bill-file'), file)
    await user.click(screen.getByRole('button', { name: /read my bill/i }))
    expect(await screen.findByText(/not available right now/i)).toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: /try again/i }))
    await screen.findByRole('heading', { name: /review & confirm/i })
    expect(screen.getByText(/please check every number/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/total consumption/i)).toHaveValue('280')
    expect(screen.getByLabelText(/total amount due/i)).toHaveValue('') // partial values preserved, missing one left for the user
    expect(screen.getByText(/generation/i)).toBeInTheDocument()
    expect(screen.getByText(/this photo was hard to read/i)).toBeInTheDocument()
    expect(screen.getAllByText(/not found on the photo/i)).toHaveLength(1)
    expect(Object.values(stored().bills ?? {})).toHaveLength(0)
  })

  it('rejects unsupported files before upload', async () => {
    const user = userEvent.setup({ applyAccept: false })
    renderApp('/bill')
    await user.upload(await screen.findByTestId('bill-file'), new File(['x'], 'a.gif', { type: 'image/gif' }))
    expect(await screen.findByText(/please choose a jpeg, png or webp/i)).toBeInTheDocument()
  })

  it('advisor shows an honest unavailable state and no fabricated reply', async () => {
    const user = userEvent.setup()
    renderApp('/advisor')
    await user.click(await screen.findByRole('button', { name: /how can i lower/i }))
    expect(await screen.findByText(/energy advisor is not available right now/i)).toBeInTheDocument()
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument()
    expect(within(screen.getByTestId('chat-log')).queryAllByText(/./).filter((n) => n.closest('.bg-slate-100'))).toHaveLength(0)
    expect(screen.getByTestId('advisor-facts')).toHaveTextContent(/no confirmed bill/i)
  })

  it('advisor success renders the reply, the calculator result and unverified-figure warnings', async () => {
    vi.restoreAllMocks()
    let sent: Record<string, unknown> = {}
    mockFetch((url, init) => {
      if (url.endsWith('/health')) return { status: 200, body: { status: 'ok', ocrAvailable: true, aiAvailable: true } }
      sent = JSON.parse(String(init?.body))
      return {
        status: 200,
        body: {
          reply: 'Try 6 hours: about 3.9 kWh saved.',
          toolCalls: [{ name: 'simulate_usage_change', args: {}, result: { appliance: 'Fan', baseline: { hoursPerDay: 8 }, scenario: { hoursPerDay: 6 }, savedKwh: 3.9, savedPhp: 48.48, baselineKwh: 15.6, scenarioKwh: 11.7, deltaKwh: -3.9, direction: 'decrease' } }],
          unverifiedFigures: ['₱999'],
          model: 'm',
        },
      }
    })
    const user = userEvent.setup()
    renderApp('/advisor')
    await user.type(await screen.findByLabelText(/bakit ang taas/i), 'Bakit ang taas ng kuryente namin?{Enter}')
    expect(await screen.findByText('Try 6 hours: about 3.9 kWh saved.')).toBeInTheDocument()
    expect(screen.getByText(/calculated by smartwatts/i)).toHaveTextContent('₱48.48')
    expect(screen.getByText(/do not match smartwatts calculations: ₱999/i)).toBeInTheDocument()
    expect(sent).toMatchObject({ message: 'Bakit ang taas ng kuryente namin?', language: 'en', household: { bills: [], appliances: [] } })
  })

  it('analytics empty states: no bills, then one bill (no fabricated trend)', async () => {
    const user = userEvent.setup()
    const v = renderApp('/analytics')
    expect(await screen.findByText(/no bills yet/i)).toBeInTheDocument()
    expect(screen.getByText(/no confirmed appliances yet/i)).toBeInTheDocument()
    v.unmount()
    renderApp('/bill')
    await enterBill(user, /effective rate from this bill/i)
    await screen.findByRole('heading', { name: /your appliances/i })
    await user.click(screen.getAllByRole('link', { name: /trends/i })[0])
    expect(await screen.findByText(/you have one bill so far/i)).toBeInTheDocument()
    expect(screen.queryByTestId('bill-change')).not.toBeInTheDocument()
  })

  it('switching to Filipino translates the UI and persists', async () => {
    const user = userEvent.setup()
    const v = renderApp('/language')
    await user.click(await screen.findByRole('button', { name: 'Filipino' }))
    expect(await screen.findByRole('heading', { name: /idagdag ang meralco bill mo/i })).toBeInTheDocument()
    v.unmount()
    renderApp('/')
    expect(await screen.findByRole('button', { name: /magsimula/i })).toBeInTheDocument()
    await waitFor(() => expect(Object.values(stored().profile ?? {})).toMatchObject([{ id: 'household', language: 'fil' }]))
  })
})
