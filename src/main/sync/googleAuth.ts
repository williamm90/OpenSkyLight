import http from 'node:http'
import crypto from 'node:crypto'
import { AddressInfo } from 'node:net'
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library'
import { and, eq, isNull } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { calendars, events, googleAccounts } from '../db/schema'
import type { SettingsService } from '../services/settingsService'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import { AppError, invalid, notFound } from '../services/errors'
import type { SecretBox } from '../secretBox'

const SCOPES = ['https://www.googleapis.com/auth/calendar', 'openid', 'email']
const KEY_CLIENT_ID = 'google.clientId'
const KEY_CLIENT_SECRET = 'google.clientSecretEnc'
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Fixed loopback redirect for the paste-back flow (Desktop OAuth clients accept any loopback port). */
const PASTE_BACK_REDIRECT = 'http://127.0.0.1:8421/'
const PASTE_BACK_TTL_MS = 30 * 60 * 1000

export interface GoogleAuthDeps {
  secrets: SecretBox
  /** Opens a URL in a browser on THIS machine (desktop app only). */
  openExternal?: (url: string) => void
}

export function createGoogleAuth(db: AppDb, settings: SettingsService, deps: GoogleAuthDeps) {
  let connectInFlight = false
  let pendingPasteBack: { verifier: string; state: string; expiresAt: number } | null = null
  const encryptSecret = (plain: string): Buffer => deps.secrets.encrypt(plain)
  const decryptSecret = (buf: Buffer): string => deps.secrets.decrypt(buf)

  function getCredentials(): { clientId: string; clientSecret: string } | null {
    const clientId = settings.getRaw(KEY_CLIENT_ID)
    const secretB64 = settings.getRaw(KEY_CLIENT_SECRET)
    if (!clientId || !secretB64) return null
    try {
      return { clientId, clientSecret: decryptSecret(Buffer.from(secretB64, 'base64')) }
    } catch {
      return null
    }
  }

  function setCredentials(clientId: string, clientSecret: string): void {
    settings.setRaw(KEY_CLIENT_ID, clientId.trim())
    settings.setRaw(KEY_CLIENT_SECRET, encryptSecret(clientSecret.trim()).toString('base64'))
  }

  function isConfigured(): boolean {
    return getCredentials() !== null
  }

  function listAccounts(): { id: string; email: string; error: string | null }[] {
    return db
      .select()
      .from(googleAccounts)
      .all()
      .map((a) => ({ id: a.id, email: a.email, error: a.lastRefreshError }))
  }

  /** Loopback OAuth flow: opens the system browser, waits for the redirect. */
  async function connect(): Promise<{ email: string }> {
    const creds = getCredentials()
    if (!creds) throw new AppError('NOT_CONFIGURED', 'Enter your Google OAuth client ID and secret first')
    if (connectInFlight) throw new AppError('BUSY', 'A Google sign-in is already in progress')
    connectInFlight = true
    try {
      const code = await waitForAuthCode(creds)
      const account = await exchangeAndStore(creds, code.code, code.redirectUri, code.verifier)
      return { email: account.email }
    } finally {
      connectInFlight = false
    }
  }

  function waitForAuthCode(creds: {
    clientId: string
    clientSecret: string
  }): Promise<{ code: string; redirectUri: string; verifier: string }> {
    return new Promise((resolve, reject) => {
      const verifier = b64url(crypto.randomBytes(32))
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())

      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          `<html><body style="font-family:sans-serif;text-align:center;padding-top:4rem">
             <h2>${code ? 'Connected!' : 'Sign-in failed'}</h2>
             <p>You can close this tab and return to your OpenSkyLight display.</p>
           </body></html>`
        )
        if (code) {
          cleanup()
          resolve({ code, redirectUri, verifier })
        } else if (error) {
          cleanup()
          reject(new AppError('AUTH_DENIED', `Google sign-in failed: ${error}`))
        }
      })

      let redirectUri = ''
      const timer = setTimeout(() => {
        cleanup()
        reject(new AppError('AUTH_TIMEOUT', 'Google sign-in timed out'))
      }, CONNECT_TIMEOUT_MS)

      function cleanup(): void {
        clearTimeout(timer)
        server.close()
      }

      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port
        redirectUri = `http://127.0.0.1:${port}`
        const client = new OAuth2Client({
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          redirectUri
        })
        const authUrl = client.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: SCOPES,
          code_challenge_method: CodeChallengeMethod.S256,
          code_challenge: challenge
        })
        if (!deps.openExternal) {
          cleanup()
          reject(new AppError('NO_BROWSER', 'This server has no browser — use the paste-back sign-in'))
          return
        }
        deps.openExternal(authUrl)
      })
      server.on('error', (err) => {
        cleanup()
        reject(err)
      })
    })
  }

  async function exchangeAndStore(
    creds: { clientId: string; clientSecret: string },
    code: string,
    redirectUri: string,
    verifier: string
  ): Promise<{ id: string; email: string }> {
    const client = new OAuth2Client({ clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri })
    const { tokens } = await client.getToken({ code, codeVerifier: verifier, redirect_uri: redirectUri })
    if (!tokens.refresh_token) throw new AppError('NO_REFRESH_TOKEN', 'Google did not return a refresh token')

    const userinfo = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    })
    const profile = (await userinfo.json()) as { email?: string }
    const email = profile.email ?? 'unknown'

    const enc = encryptSecret(tokens.refresh_token)
    const existing = db.select().from(googleAccounts).where(eq(googleAccounts.email, email)).all()
    if (existing.length > 0) {
      db.update(googleAccounts)
        .set({ refreshTokenEnc: enc, lastRefreshError: null, connectedAt: isoUtc(DateTime.utc()) })
        .where(eq(googleAccounts.id, existing[0].id))
        .run()
      return { id: existing[0].id, email }
    }
    const id = uuidv7()
    db.insert(googleAccounts)
      .values({ id, email, refreshTokenEnc: enc, scopes: SCOPES.join(' '), connectedAt: isoUtc(DateTime.utc()) })
      .run()
    return { id, email }
  }

  /**
   * Headless sign-in, step 1: returns a Google consent URL whose redirect is a
   * loopback address nobody listens on. After consenting, the browser shows a
   * "can't connect" page whose address bar holds the auth code.
   */
  function beginPasteBack(): { authUrl: string } {
    const creds = getCredentials()
    if (!creds) throw new AppError('NOT_CONFIGURED', 'Enter your Google OAuth client ID and secret first')
    const verifier = b64url(crypto.randomBytes(32))
    const state = b64url(crypto.randomBytes(16))
    pendingPasteBack = { verifier, state, expiresAt: Date.now() + PASTE_BACK_TTL_MS }
    const client = new OAuth2Client({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      redirectUri: PASTE_BACK_REDIRECT
    })
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest())
    })
    return { authUrl }
  }

  /** Headless sign-in, step 2: the user pastes the dead-end URL back in. */
  async function finishPasteBack(pastedUrl: string): Promise<{ email: string }> {
    const creds = getCredentials()
    if (!creds) throw new AppError('NOT_CONFIGURED', 'Enter your Google OAuth client ID and secret first')
    const pending = pendingPasteBack
    if (!pending || Date.now() > pending.expiresAt) {
      throw new AppError('AUTH_EXPIRED', 'Sign-in link expired — tap "Get sign-in link" again')
    }
    const { code, state } = parsePastedRedirect(pastedUrl)
    if (state !== pending.state) throw invalid('That link is from a different sign-in attempt — start again')
    pendingPasteBack = null
    const account = await exchangeAndStore(creds, code, PASTE_BACK_REDIRECT, pending.verifier)
    return { email: account.email }
  }

  /** An OAuth2Client ready for API calls for a stored account. */
  function getAuthedClient(accountId: string): OAuth2Client {
    const creds = getCredentials()
    if (!creds) throw new AppError('NOT_CONFIGURED', 'Google credentials missing')
    const [account] = db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId)).all()
    if (!account?.refreshTokenEnc) throw notFound('Google account')
    const client = new OAuth2Client({ clientId: creds.clientId, clientSecret: creds.clientSecret })
    client.setCredentials({ refresh_token: decryptSecret(Buffer.from(account.refreshTokenEnc)) })
    return client
  }

  function markAuthError(accountId: string, message: string | null): void {
    db.update(googleAccounts).set({ lastRefreshError: message }).where(eq(googleAccounts.id, accountId)).run()
  }

  function disconnect(accountId: string): void {
    const [account] = db.select().from(googleAccounts).where(eq(googleAccounts.id, accountId)).all()
    if (!account) throw notFound('Google account')
    const now = isoUtc(DateTime.utc())
    db.transaction((tx) => {
      const cals = tx
        .select()
        .from(calendars)
        .where(and(eq(calendars.googleAccountId, accountId), isNull(calendars.deletedAt)))
        .all()
      for (const cal of cals) {
        tx.update(events).set({ deletedAt: now }).where(and(eq(events.calendarId, cal.id), isNull(events.deletedAt))).run()
        tx.update(calendars).set({ deletedAt: now }).where(eq(calendars.id, cal.id)).run()
      }
      tx.delete(googleAccounts).where(eq(googleAccounts.id, accountId)).run()
    })
  }

  return {
    isConfigured,
    setCredentials,
    connect,
    beginPasteBack,
    finishPasteBack,
    listAccounts,
    getAuthedClient,
    markAuthError,
    disconnect
  }
}

export type GoogleAuth = ReturnType<typeof createGoogleAuth>

export function assertHttpsUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw invalid('Not a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw invalid('Feed URLs must be http(s)')
  }
}

/** Pull `code` and `state` out of whatever the user pasted (full URL or bare query). */
export function parsePastedRedirect(pasted: string): { code: string; state: string | null } {
  const text = pasted.trim()
  let params: URLSearchParams
  try {
    params = new URL(text).searchParams
  } catch {
    params = new URLSearchParams(text.includes('?') ? text.slice(text.indexOf('?') + 1) : text)
  }
  const error = params.get('error')
  if (error) throw new AppError('AUTH_DENIED', `Google sign-in failed: ${error}`)
  const code = params.get('code')
  if (!code) throw invalid('Paste the whole address from the page Google sent you to (it contains "code=")')
  return { code, state: params.get('state') }
}
