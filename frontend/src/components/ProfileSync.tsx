import { useEffect } from 'react'
import { useI18n } from '@/i18n'
import { useData } from '@/lib/data'

/**
 * Keeps the HouseholdProfile's language in step with the UI language.
 * - A saved profile language is applied when this browser has no explicit choice yet
 *   (e.g. same household opened on a new device after account linking).
 * - An explicit choice on this device is saved to the profile.
 */
export function ProfileSync() {
  const { lang, hasChosen, setLang } = useI18n()
  const { ready, profile, saveProfile } = useData()
  useEffect(() => {
    if (!ready) return
    if (!hasChosen) {
      if (profile && profile.language !== lang) setLang(profile.language)
      return
    }
    if (profile?.language !== lang) saveProfile(lang).catch(() => {})
  }, [ready, hasChosen, profile, lang, setLang, saveProfile])
  return null
}
