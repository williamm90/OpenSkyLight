import { randomInt } from 'node:crypto'
import type { SettingsService } from '../main/services/settingsService'
import { createCompanionTokens } from '../main/companion/companionTokens'

const STORE_KEY = 'display.tokens.v1'
const CODE_TTL_MS = 15 * 60 * 1000
/** Wrong guesses allowed per code before it is burned (1-in-100,000 odds). */
const MAX_ATTEMPTS = 10
export const DISPLAY_COOKIE = 'osl_display'
const COOKIE_MAX_AGE_S = 10 * 365 * 24 * 60 * 60

/**
 * Pairs browser screens (the wall tablet) with the server. A parent reads a
 * 6-digit code from the server log or an already-paired screen's settings,
 * types it on the new screen, and that screen gets a long-lived HttpOnly
 * cookie. Cookies — not bearer headers — because <img>, EventSource and
 * WebSocket requests can't carry custom headers.
 */
export function createDisplayAuth(settings: Pick<SettingsService, 'getRaw' | 'setRaw' | 'deleteRaw'>) {
  const tokens = createCompanionTokens(settings, STORE_KEY)
  let pending: { code: string; expiresAt: number; attempts: number } | null = null

  function issueCode(): { code: string; expiresAt: string } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = Date.now() + CODE_TTL_MS
    pending = { code, expiresAt, attempts: 0 }
    return { code, expiresAt: new Date(expiresAt).toISOString() }
  }

  /** Exchange a code for a token. Single use; burned after too many misses. */
  function redeem(code: string): { token: string } | { error: string } {
    const p = pending
    if (!p || Date.now() > p.expiresAt) return { error: 'No pairing code is active — make a new one' }
    if (String(code).trim() !== p.code) {
      p.attempts += 1
      if (p.attempts >= MAX_ATTEMPTS) pending = null
      return { error: 'That code didn’t match' }
    }
    pending = null
    return { token: tokens.issue() }
  }

  function verify(token: string | undefined): boolean {
    return !!token && tokens.verify(token)
  }

  function pairedCount(): number {
    return tokens.count()
  }

  function unpairAll(): void {
    tokens.revokeAll()
  }

  function cookieFor(token: string, secure: boolean): string {
    return `${DISPLAY_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`
  }

  return { issueCode, redeem, verify, pairedCount, unpairAll, cookieFor }
}

export type DisplayAuth = ReturnType<typeof createDisplayAuth>

/** Minimal cookie header parser. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}
