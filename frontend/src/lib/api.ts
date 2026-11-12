/** Typed client for the SmartWatts FastAPI backend. Secrets never live here. */
import { isUnset } from './envRules'
import type { Appliance, Bill, BillCharge, CompareResult, Rate } from './types'

// '/api' in dev/preview is proxied to FastAPI by Vite. In production set VITE_API_BASE_URL to https://<backend>/api.
const rawBase = import.meta.env.VITE_API_BASE_URL as string | undefined
const BASE = (isUnset(rawBase) ? '/api' : rawBase!.trim()).replace(/\/$/, '')

export type ApiErrorCode =
  | 'offline' | 'timeout' | 'network' | 'unsupported_type' | 'bad_image' | 'ocr_unavailable' | 'ai_unavailable'
  | 'rate_limited' | 'invalid_request' | 'server_error'

export class ApiError extends Error {
  code: ApiErrorCode
  status: number
  constructor(code: ApiErrorCode, status: number, message: string = code) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ApiError('offline', 0)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal })
  } catch (e) {
    throw new ApiError((e as Error).name === 'AbortError' ? 'timeout' : 'network', 0)
  } finally {
    clearTimeout(timer)
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) {
    const detail = (body as { detail?: { code?: string; message?: string } } | null)?.detail
    const known: ApiErrorCode[] = ['unsupported_type', 'bad_image', 'ocr_unavailable', 'ai_unavailable', 'rate_limited', 'invalid_request']
    const code: ApiErrorCode = known.includes(detail?.code as ApiErrorCode) ? (detail!.code as ApiErrorCode) : 'server_error'
    throw new ApiError(code, res.status, detail?.message)
  }
  return body as T
}

export interface Health {
  status: string
  ocrAvailable: boolean
  aiAvailable: boolean
}
export const getHealth = () => request<Health>('/health', { method: 'GET' }, 5000)

export interface BillOcrResult {
  fields: { periodStart: string | null; periodEnd: string | null; kwh: number | null; totalAmountPhp: number | null; charges: BillCharge[] }
  fieldStatus: Record<'periodStart' | 'periodEnd' | 'kwh' | 'totalAmountPhp', 'read' | 'not_found'>
  confidence: number | null
  lowConfidence: boolean
  warnings: string[]
}
export interface LabelOcrResult {
  suggestedWattage: number | null
  candidates: number[]
  confidence: number | null
  lowConfidence: boolean
  warnings: string[]
}

function upload<T>(path: string, file: File): Promise<T> {
  const fd = new FormData()
  fd.append('file', file)
  return request<T>(path, { method: 'POST', body: fd }, 45000)
}
export const ocrBill = (file: File) => upload<BillOcrResult>('/ocr/bill', file)
export const ocrLabel = (file: File) => upload<LabelOcrResult>('/ocr/label', file)

export interface AdvisorTurn {
  role: 'user' | 'assistant'
  text: string
}
export interface AdvisorToolCall {
  name: string
  args: Record<string, unknown>
  result: (CompareResult & { appliance: string; baseline: Record<string, number>; scenario: Record<string, number> }) | { error: string }
}
export interface AdvisorResponse {
  reply: string
  toolCalls: AdvisorToolCall[]
  unverifiedFigures: string[]
  model: string
}

/** Only confirmed, non-personal numbers are sent: no names beyond appliance labels, no notes. */
export function buildHousehold(bills: Bill[], appliances: Appliance[], rate: Rate | null) {
  return {
    bills: bills.map(({ periodStart, periodEnd, kwh, amountPhp }) => ({ periodStart, periodEnd, kwh, amountPhp })).slice(-36),
    rate,
    appliances: appliances
      .filter((a) => a.confirmed)
      .slice(0, 60)
      .map(({ id, name, type, wattage, quantity, hoursPerDay, daysPerPeriod }) => ({ id, name, type, wattage, quantity, hoursPerDay, daysPerPeriod })),
  }
}

export const askAdvisor = (payload: { message: string; language: 'en' | 'fil'; history: AdvisorTurn[]; household: ReturnType<typeof buildHousehold> }) =>
  request<AdvisorResponse>('/advisor/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 40000)

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const isAcceptableImage = (f: File) => ACCEPTED_IMAGE_TYPES.includes(f.type) && f.size > 0 && f.size <= MAX_UPLOAD_BYTES
