/** Extend a live stream this long before Google's 5-minute session expires. */
export const EXTEND_LEAD_MS = 30_000
/** Wait this long before retrying a stream that failed or ended. */
export const RESTART_DELAY_MS = 10_000

/** How long to wait before extending a stream that expires at `expiresAt`. */
export function extendDelayMs(expiresAt: string, now: number = Date.now()): number {
  const at = Date.parse(expiresAt)
  if (Number.isNaN(at)) return 4 * 60_000 // sessions last 5 minutes; be safe
  return Math.max(5_000, at - now - EXTEND_LEAD_MS)
}

/** Should a live tile be streaming right now? */
export function shouldStream(opts: { mode: 'tap' | 'always'; tapped: boolean; covered: boolean; webrtc: boolean }): boolean {
  if (!opts.webrtc || opts.covered) return false
  return opts.mode === 'always' || opts.tapped
}
