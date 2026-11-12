/** Persist partially completed forms so a refresh or navigation does not lose them. */
export function loadDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`smartwatts:draft:${key}`)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
export function saveDraft<T>(key: string, value: T) {
  try {
    localStorage.setItem(`smartwatts:draft:${key}`, JSON.stringify(value))
  } catch {
    /* non-critical */
  }
}
export function clearDraft(key: string) {
  try {
    localStorage.removeItem(`smartwatts:draft:${key}`)
  } catch {
    /* non-critical */
  }
}
