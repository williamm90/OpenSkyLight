/**
 * Browser transport for the display UI when it is served by the headless home
 * server (e.g. on a wall tablet) instead of running inside Electron. Provides
 * the same `window.osl` surface the preload bridge does:
 *   invoke → POST /api/rpc/<channel>  (cookie-authenticated)
 *   on     → one shared Server-Sent Events stream at /api/events
 */
type Listener = (data: unknown) => void

declare global {
  interface Window {
    __oslWeb?: boolean
  }
}

/** True when there is no Electron preload bridge (or the web bridge is installed). */
export function isWebMode(): boolean {
  return window.__oslWeb === true || !(window as { osl?: unknown }).osl
}

export function installWebBridge(): void {
  const listeners = new Map<string, Set<Listener>>()
  let source: EventSource | null = null
  let opened = false

  function emit(channel: string, payload: unknown): void {
    for (const cb of listeners.get(channel) ?? []) {
      try {
        cb(payload)
      } catch (err) {
        console.error('[bridge] listener failed', err)
      }
    }
  }

  function ensureStream(): void {
    if (source) return
    source = new EventSource('/api/events')
    source.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { channel: string; payload: unknown }
        emit(msg.channel, msg.payload)
      } catch {
        // ignore malformed frames
      }
    }
    source.onopen = () => {
      // after a reconnect we may have missed pushes, so tell the app to refetch
      if (opened) emit('push:reconnected', null)
      opened = true
    }
  }

  window.osl = {
    async invoke(channel, payload) {
      let res: Response
      try {
        res = await fetch(`/api/rpc/${encodeURIComponent(channel)}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-OSL': '1' },
          body: payload === undefined ? '' : JSON.stringify(payload)
        })
      } catch {
        return { ok: false, error: { code: 'OFFLINE', message: "Can't reach the home server" } }
      }
      if (res.status === 401) {
        // pairing was revoked: back to the pairing screen
        window.location.reload()
        return { ok: false, error: { code: 'UNPAIRED', message: "This screen isn't paired" } }
      }
      try {
        return await res.json()
      } catch {
        return { ok: false, error: { code: 'INTERNAL', message: `Server error (HTTP ${res.status})` } }
      }
    },
    on(channel, callback) {
      ensureStream()
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      const bucket = set
      bucket.add(callback)
      return () => {
        bucket.delete(callback)
      }
    }
  }
  window.__oslWeb = true
}

export async function fetchPairedStatus(): Promise<boolean | 'offline'> {
  try {
    const res = await fetch('/api/display/status', { credentials: 'same-origin' })
    const body = (await res.json()) as { data?: { paired?: boolean } }
    return !!body.data?.paired
  } catch {
    return 'offline'
  }
}

/** Returns null on success, else a message to show. */
export async function pairWithCode(code: string): Promise<string | null> {
  try {
    const res = await fetch('/api/display/pair', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    })
    if (res.ok) return null
    const body = (await res.json()) as { error?: { message?: string } }
    return body.error?.message ?? 'Pairing failed'
  } catch {
    return "Can't reach the home server"
  }
}
