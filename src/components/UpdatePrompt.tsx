import { useTranslation } from 'react-i18next'
import { useRegisterSW } from 'virtual:pwa-register/react'

/** Shows a banner when a new app version is available; never reloads silently mid-entry. */
export function UpdatePrompt() {
  const { t } = useTranslation()
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW()
  if (!needRefresh) return null
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-20 mx-auto flex max-w-xl items-center justify-between gap-2 bg-navy-900 px-4 py-3 text-white">
      <span className="text-sm">{t('common.updateAvailable')}</span>
      <button type="button" className="rounded-lg bg-brand-500 px-3 font-semibold" onClick={() => void updateServiceWorker(true)}>
        {t('common.update')}
      </button>
    </div>
  )
}
