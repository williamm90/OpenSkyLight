/**
 * Process-wide push bus. Services emit `push:*` events here; each runtime
 * subscribes its own transport (Electron windows, or Server-Sent Events for
 * browser displays) so no service ever imports a UI framework.
 */
type Listener = (channel: string, payload: unknown) => void

const listeners = new Set<Listener>()

export function broadcast(channel: string, payload: unknown): void {
  for (const listener of listeners) {
    try {
      listener(channel, payload)
    } catch (err) {
      console.error('[bus] listener failed:', err)
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
