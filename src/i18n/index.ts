import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { de } from './de'
import { en } from './en'

const STORAGE_KEY = 'travelsplit.lang'

function initialLanguage(): 'de' | 'en' {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'de' || stored === 'en') return stored
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('en') ? 'en' : 'de'
}

void i18n.use(initReactI18next).init({
  resources: { de: { translation: de }, en: { translation: en } },
  lng: typeof window === 'undefined' ? 'de' : initialLanguage(),
  fallbackLng: 'de',
  interpolation: { escapeValue: false },
  returnNull: false,
})

i18n.on('languageChanged', (lng) => {
  try {
    localStorage.setItem(STORAGE_KEY, lng)
  } catch {
    /* ignore */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = lng
})

export default i18n
