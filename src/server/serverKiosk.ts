import { readdirSync } from 'node:fs'
import { extname } from 'node:path'
import { DateTime } from 'luxon'
import type { SettingsService } from '../main/services/settingsService'
import { AppError } from '../main/services/errors'
import { isInSleepWindow } from '@shared/sleepWindow'

const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
const SLEEP_POLL_MS = 5_000

/**
 * The headless counterpart of the Electron kiosk. The server can't see the
 * tablet's touch input, so screensaver idle is tracked by the display itself;
 * the server only owns the nightly sleep window (one clock for every screen).
 */
export function createServerKiosk(deps: { settings: SettingsService; broadcast: (ch: string, p: unknown) => void }) {
  const { settings, broadcast } = deps
  let sleepTimer: NodeJS.Timeout | null = null
  let sleeping = false

  function listPhotos(): string[] {
    const folder = settings.getAll().screensaver.folder
    if (!folder) return []
    try {
      return readdirSync(folder)
        .filter((f) => PHOTO_EXTENSIONS.has(extname(f).toLowerCase()))
        .sort()
        .map((f) => `/media/photos/${encodeURIComponent(f)}`)
    } catch {
      return []
    }
  }

  async function pickFolder(): Promise<{ folder: string | null }> {
    throw new AppError('UNSUPPORTED', 'Type the photo folder path on the server instead')
  }

  function previewScreensaver(): void {
    broadcast('push:kioskIdle', { state: 'screensaver' })
  }

  function evaluateSleep(): void {
    const s = settings.getAll().sleep
    const now = DateTime.now()
    const next = s.enabled && isInSleepWindow(now.hour * 60 + now.minute, s.start, s.end)
    if (next === sleeping) return
    sleeping = next
    broadcast('push:sleepState', { sleeping })
  }

  function start(): void {
    evaluateSleep()
    sleepTimer = setInterval(evaluateSleep, SLEEP_POLL_MS)
  }

  function stop(): void {
    if (sleepTimer) clearInterval(sleepTimer)
  }

  /** Snapshot pushed to each display as it connects (pushes are edge-triggered). */
  function currentState(): { sleeping: boolean } {
    return { sleeping }
  }

  return {
    start,
    stop,
    listPhotos,
    pickFolder,
    previewScreensaver,
    setLaunchOnStartup: (): void => undefined,
    currentState
  }
}

export type ServerKiosk = ReturnType<typeof createServerKiosk>
