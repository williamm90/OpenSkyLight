import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ipcInvoke } from '../../api/client'
import { useAuthMutations, useAuthStatus, useSettings } from '../../api/hooks'
import { isWebMode } from '../../api/webBridge'
import { PinDialog } from '../../components/PinDialog'
import { useKioskState } from '../../stores/kioskStore'
import { buildGoogleHomeLink, GOOGLE_HOME_WEB, needsPinForCameras } from '@shared/googleHome'
import { extendDelayMs, RESTART_DELAY_MS, shouldStream } from '@shared/nestStream'
import type { AppSettings } from '@shared/types'
import type { TileProps } from '../home/tiles'

const DEFAULT_CAMERAS: AppSettings['cameras'] = { open: 'app', requirePin: true, live: 'tap' }

function useCameraSettings(): AppSettings['cameras'] {
  const { data: settings } = useSettings()
  return settings?.cameras ?? DEFAULT_CAMERAS
}

/** Opens Google Home (app on the tablet, website elsewhere), behind the parent PIN when set. */
function useOpenGoogleHome(): { open: () => void; pinDialog: ReactNode } {
  const cameras = useCameraSettings()
  const { data: auth } = useAuthStatus()
  const authMutations = useAuthMutations()
  const [pinOpen, setPinOpen] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)

  const go = (): void => {
    if (isWebMode()) window.location.href = buildGoogleHomeLink(cameras.open)
    else window.open(GOOGLE_HOME_WEB, '_blank') // desktop app: system browser
  }
  const open = (): void => {
    if (needsPinForCameras(cameras.requirePin, auth)) {
      setPinError(null)
      setPinOpen(true)
    } else go()
  }

  const pinDialog = (
    <PinDialog
      open={pinOpen}
      title="Enter parent PIN"
      error={pinError}
      onClose={() => setPinOpen(false)}
      onSubmit={(pin) =>
        authMutations.verifyPin.mutate(
          { pin },
          {
            onSuccess: (res) => {
              if (!res.valid) return setPinError('Wrong PIN — try again')
              setPinOpen(false)
              authMutations.lock.mutate(undefined) // don't leave the hub unlocked
              go()
            }
          }
        )
      }
    />
  )
  return { open, pinDialog }
}

/** A big button that opens Google Home. */
export function GoogleHomeTile({ compact }: TileProps) {
  const { open, pinDialog } = useOpenGoogleHome()
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          open()
        }}
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-2xl bg-paper-deep/60 active:scale-[0.98]"
      >
        <span className={compact ? 'text-4xl' : 'text-6xl'} aria-hidden>
          📹
        </span>
        <span className="text-lg font-bold">Open Google Home</span>
      </button>
      {pinDialog}
    </div>
  )
}

type LiveStatus = 'idle' | 'connecting' | 'live' | 'error'

/**
 * Live view of one Google Home / Nest camera over WebRTC. The server only
 * swaps the offer/answer with Google; video goes straight from Google to here.
 */
export function NestCameraTile({ tile }: TileProps) {
  const deviceId = tile.config?.nestDeviceId ?? null
  const cameras = useCameraSettings()
  const covered = useKioskState((s) => s.covered)
  const { open: openGoogleHome, pinDialog } = useOpenGoogleHome()
  const { data: list, isPending, error: listError } = useQuery({
    queryKey: ['nestCameras'],
    queryFn: () => ipcInvoke('nest:listCameras', undefined),
    staleTime: 5 * 60_000,
    retry: 1
  })
  const camera = (list ?? []).find((c) => c.id === deviceId)
  const webrtc = camera?.webrtc ?? false
  const videoRef = useRef<HTMLVideoElement>(null)
  const [tapped, setTapped] = useState(false)
  const [status, setStatus] = useState<LiveStatus>('idle')
  const [restartKey, setRestartKey] = useState(0)

  const streaming = shouldStream({ mode: cameras.live, tapped, covered, webrtc })

  useEffect(() => {
    const video = videoRef.current
    if (!deviceId || !streaming || !video) {
      setStatus('idle')
      return
    }
    let stopped = false
    let session: string | null = null
    let extendTimer: number | undefined
    let restartTimer: number | undefined
    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' })
    setStatus('connecting')

    const endSession = (): void => {
      if (stopped) return
      if (cameras.live === 'always') {
        setStatus('error')
        restartTimer = window.setTimeout(() => setRestartKey((k) => k + 1), RESTART_DELAY_MS)
      } else {
        setTapped(false) // tap mode: one ~5-minute session, then back to "Tap to watch"
      }
    }

    pc.ontrack = (e) => {
      if (e.track.kind !== 'video') return
      video.srcObject = e.streams[0] ?? new MediaStream([e.track])
      void video.play().catch(() => undefined)
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setStatus('live')
      if (pc.connectionState === 'failed') endSession()
    }

    const scheduleExtend = (expiresAt: string): void => {
      if (cameras.live !== 'always') {
        // tap mode never extends — stop when Google's session ends
        extendTimer = window.setTimeout(endSession, extendDelayMs(expiresAt) + 30_000)
        return
      }
      extendTimer = window.setTimeout(() => {
        if (stopped || !session) return
        ipcInvoke('nest:extendStream', { deviceId, mediaSessionId: session })
          .then((r) => {
            session = r.mediaSessionId
            scheduleExtend(r.expiresAt)
          })
          .catch(endSession)
      }, extendDelayMs(expiresAt))
    }

    // Google requires m-lines in this order: audio (recvonly), video, data channel
    pc.addTransceiver('audio', { direction: 'recvonly' })
    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.createDataChannel('osl')

    void (async () => {
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        if (stopped) return
        const res = await ipcInvoke('nest:startStream', { deviceId, offerSdp: offer.sdp ?? '' })
        if (stopped) {
          void ipcInvoke('nest:stopStream', { deviceId, mediaSessionId: res.mediaSessionId }).catch(() => undefined)
          return
        }
        session = res.mediaSessionId
        await pc.setRemoteDescription({ type: 'answer', sdp: res.answerSdp })
        scheduleExtend(res.expiresAt)
      } catch {
        endSession()
      }
    })()

    return () => {
      stopped = true
      window.clearTimeout(extendTimer)
      window.clearTimeout(restartTimer)
      pc.close()
      video.srcObject = null
      if (session) void ipcInvoke('nest:stopStream', { deviceId, mediaSessionId: session }).catch(() => undefined)
    }
  }, [deviceId, streaming, cameras.live, restartKey])

  if (!deviceId) return <Message>Pick a camera — edit the home screen and re-add this tile</Message>
  if (isPending) return <Message>Connecting…</Message>
  if (listError) return <Message>Google Home cameras aren’t connected — Settings → General → Cameras</Message>
  if (!camera) return <Message>Camera not found — re-add this tile</Message>

  return (
    <div className="relative -m-4 h-[calc(100%+2rem)] overflow-hidden bg-black/90">
      <video ref={videoRef} muted autoPlay playsInline className="h-full w-full object-cover" />
      <span className="absolute top-2 left-2 rounded-full bg-black/55 px-2.5 py-1 text-xs font-extrabold text-white/90">
        {camera.name}
        {status === 'live' && <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-[#e5484d] align-middle" />}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          openGoogleHome()
        }}
        className="absolute top-2 right-2 rounded-full bg-black/55 px-3 py-1.5 text-xs font-extrabold text-white/90 active:scale-95"
      >
        More ›
      </button>
      {status !== 'live' && (
        <button
          type="button"
          disabled={!webrtc || status === 'connecting'}
          onClick={(e) => {
            e.stopPropagation()
            setTapped(true)
          }}
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-white/85"
        >
          {!webrtc ? (
            <span className="px-4 text-center text-sm font-bold">This camera can’t play here yet — tap More</span>
          ) : status === 'connecting' ? (
            <span className="text-sm font-bold">Connecting…</span>
          ) : status === 'error' ? (
            <span className="text-sm font-bold">Camera unavailable — retrying</span>
          ) : (
            <>
              <span className="text-5xl" aria-hidden>
                ▶
              </span>
              <span className="text-base font-extrabold">Tap to watch</span>
            </>
          )}
        </button>
      )}
      {pinDialog}
    </div>
  )
}

function Message({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-2 text-center text-sm font-bold text-ink-faint">
      {children}
    </div>
  )
}
