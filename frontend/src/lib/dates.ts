const ISO = /^\d{4}-\d{2}-\d{2}$/

export function parseIsoDate(s: string): Date | null {
  if (!ISO.test(s)) return null
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null
}

/** Inclusive number of days in a billing period, or null if invalid. */
export function periodDays(start: string, end: string): number | null {
  const a = parseIsoDate(start)
  const b = parseIsoDate(end)
  if (!a || !b) return null
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1
}

export const monthOf = (isoDate: string) => isoDate.slice(0, 7)
