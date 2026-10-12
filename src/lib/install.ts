// Android/Chrome "install app" prompt. The event fires early, so it is captured at module load.
import { useEffect, useState } from 'react'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPromptEvent
    listeners.forEach((l) => l())
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    listeners.forEach((l) => l())
  })
}

export function isStandalone(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true)
}

/** Returns a function that opens the native install dialog, or null when the browser offers none. */
export function useInstallPrompt(): (() => Promise<void>) | null {
  const [, setTick] = useState(0)
  useEffect(() => {
    const l = () => setTick((n) => n + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  if (!deferred) return null
  const event = deferred
  return async () => {
    await event.prompt()
    await event.userChoice
    deferred = null
    listeners.forEach((l) => l())
  }
}
