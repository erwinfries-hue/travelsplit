import { useTranslation } from 'react-i18next'

export function LanguageSwitch() {
  const { i18n, t } = useTranslation()
  return (
    <div role="group" aria-label={t('profile.language')} className="inline-flex rounded-xl bg-navy-50 p-1">
      {(['de', 'en'] as const).map((lng) => (
        <button
          key={lng}
          type="button"
          aria-pressed={i18n.language === lng}
          onClick={() => void i18n.changeLanguage(lng)}
          className={`rounded-lg px-3 text-sm font-semibold ${i18n.language === lng ? 'bg-white text-navy-900 shadow' : 'text-navy-600'}`}
        >
          {lng.toUpperCase()}
        </button>
      ))}
    </div>
  )
}
