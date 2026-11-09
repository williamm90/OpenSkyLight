import { useCallback, useEffect, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import { useQuery } from '@tanstack/react-query'
import { ipcInvoke } from '../../api/client'
import { useSettings } from '../../api/hooks'
import { ZONE } from '../../stores/uiStore'
import { useKioskState } from '../../stores/kioskStore'
import { isWebMode } from '../../api/webBridge'

const IDLE_CHECK_MS = 5_000

/**
 * Browser displays track their own touch idleness (the home server can't see
 * the tablet's input). Electron gets the same signal from powerMonitor.
 */
function useClientIdleScreensaver(onIdle: () => void): void {
  const { data: settings } = useSettings()
  const idleMinutes = settings?.screensaver.idleMinutes ?? 10
  const lastActivity = useRef(Date.now())
  const fired = useRef(false)
  useEffect(() => {
    if (!isWebMode()) return
    const bump = (): void => {
      lastActivity.current = Date.now()
      fired.current = false
    }
    const events = ['pointerdown', 'keydown', 'wheel'] as const
    for (const e of events) window.addEventListener(e, bump, { passive: true, capture: true })
    const timer = window.setInterval(() => {
      if (!fired.current && Date.now() - lastActivity.current >= idleMinutes * 60_000) {
        fired.current = true
        onIdle()
      }
    }, IDLE_CHECK_MS)
    return () => {
      for (const e of events) window.removeEventListener(e, bump, { capture: true })
      window.clearInterval(timer)
    }
  }, [idleMinutes, onIdle])
}

const WAKE_OVERRIDE_MS = 5 * 60 * 1000
const SLIDE_MS = 12_000

function useClock(): DateTime {
  const [now, setNow] = useState(() => DateTime.now().setZone(ZONE))
  useEffect(() => {
    const t = setInterval(() => setNow(DateTime.now().setZone(ZONE)), 10_000)
    return () => clearInterval(t)
  }, [])
  return now
}

function ScreensaverOverlay({ onDismiss }: { onDismiss: () => void }) {
  const { data: photos = [] } = useQuery({
    queryKey: ['screensaverPhotos'],
    queryFn: () => ipcInvoke('screensaver:listPhotos', undefined),
    staleTime: 60_000
  })
  const { data: settings } = useSettings()
  const [index, setIndex] = useState(0)
  const now = useClock()
  const timeFormat = settings?.timeFormat ?? '12h'

  useEffect(() => {
    if (photos.length < 2) return
    const t = setInterval(() => setIndex((i) => (i + 1) % photos.length), SLIDE_MS)
    return () => clearInterval(t)
  }, [photos.length])

  const current = photos.length > 0 ? photos[index % photos.length] : null
  const next = photos.length > 1 ? photos[(index + 1) % photos.length] : null

  return (
    <div className="fixed inset-0 z-[80] cursor-none bg-black" onPointerDown={onDismiss}>
      {current && (
        <img
          key={current}
          src={current}
          alt=""
          className="absolute inset-0 h-full w-full object-contain"
          style={{ animation: 'fade-in 1.2s ease both' }}
        />
      )}
      {/* preload the next slide so the crossfade never flashes */}
      {next && <img src={next} alt="" className="hidden" />}
      <div className="absolute bottom-10 left-12 select-none">
        <div className="font-display text-7xl font-semibold text-white/90 drop-shadow-lg">
          {timeFormat === '24h' ? now.toFormat('HH:mm') : now.toFormat('h:mm')}
        </div>
        <div className="mt-1 text-2xl font-bold text-white/70 drop-shadow-lg">{now.toFormat('cccc, LLLL d')}</div>
      </div>
    </div>
  )
}

function SleepOverlay({ onWake }: { onWake: () => void }) {
  const now = useClock()
  return (
    <div className="fixed inset-0 z-[90] cursor-none bg-black" onPointerDown={onWake}>
      <div className="absolute right-8 bottom-6 text-xl font-semibold text-white/15 select-none">
        {now.toFormat('h:mm a').toLowerCase()}
      </div>
    </div>
  )
}

/** Mounts the sleep and screensaver layers based on main-process kiosk events. */
export function KioskOverlays() {
  const [screensaver, setScreensaver] = useState(false)
  const [sleeping, setSleeping] = useState(false)
  const [awakeOverride, setAwakeOverride] = useState(false)
  const overrideTimer = useRef<number | null>(null)
  const setCovered = useKioskState((s) => s.setCovered)
  const { data: idlePhotos = [] } = useQuery({
    queryKey: ['screensaverPhotos'],
    queryFn: () => ipcInvoke('screensaver:listPhotos', undefined),
    staleTime: 60_000
  })
  const hasPhotos = idlePhotos.length > 0
  const startScreensaver = useCallback(() => {
    if (hasPhotos) setScreensaver(true)
  }, [hasPhotos])
  useClientIdleScreensaver(startScreensaver)

  // let expensive tiles (camera streams) pause while a layer covers them
  const covered = (sleeping && !awakeOverride) || screensaver
  useEffect(() => {
    setCovered(covered)
  }, [covered, setCovered])

  useEffect(() => {
    const offIdle = window.osl.on('push:kioskIdle', (d) => {
      setScreensaver((d as { state?: string })?.state === 'screensaver')
    })
    const offSleep = window.osl.on('push:sleepState', (d) => {
      const isSleeping = Boolean((d as { sleeping?: boolean })?.sleeping)
      setSleeping(isSleeping)
      if (!isSleeping) {
        // window ended naturally — clear any tap-to-wake override
        setAwakeOverride(false)
        if (overrideTimer.current) window.clearTimeout(overrideTimer.current)
      }
    })
    return () => {
      offIdle()
      offSleep()
    }
  }, [])

  if (sleeping && !awakeOverride) {
    return (
      <SleepOverlay
        onWake={() => {
          setAwakeOverride(true)
          if (overrideTimer.current) window.clearTimeout(overrideTimer.current)
          overrideTimer.current = window.setTimeout(() => setAwakeOverride(false), WAKE_OVERRIDE_MS)
        }}
      />
    )
  }
  if (screensaver) return <ScreensaverOverlay onDismiss={() => setScreensaver(false)} />
  return null
}
