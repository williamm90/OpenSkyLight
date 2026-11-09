import crypto from 'node:crypto'
import type { SettingsService } from './settingsService'
import type { SecretBox } from '../secretBox'
import { AppError } from './errors'
import { parsePastedRedirect } from '../sync/googleAuth'
import type { NestCameraDto, NestStatusDto } from '@shared/types'

/**
 * Google Home / Nest cameras through Google Device Access (Smart Device
 * Management API). The server only brokers: it signs requests and swaps the
 * WebRTC offer/answer. Video flows straight from Google to the tablet.
 *
 * Sign-in uses Google's documented redirect (https://www.google.com) with a
 * "Web application" OAuth client, finished by pasting that page's address back.
 */

export const SDM_SCOPE = 'https://www.googleapis.com/auth/sdm.service'
export const NEST_REDIRECT = 'https://www.google.com'
const SDM_BASE = 'https://smartdevicemanagement.googleapis.com/v1'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const LIVE_TRAIT = 'sdm.devices.traits.CameraLiveStream'
const PENDING_TTL_MS = 15 * 60 * 1000
const DEVICE_CACHE_MS = 60 * 1000

const KEY_CONFIG = 'nest.config.v1'
const KEY_CLIENT_SECRET = 'nest.clientSecret.enc'
const KEY_REFRESH = 'nest.refreshToken.enc'

const PROJECT_ID = /^[A-Za-z0-9-]{8,64}$/
const DEVICE_ID = /^[A-Za-z0-9_-]{8,200}$/

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

interface NestConfig {
  projectId: string
  clientId: string
}

interface SdmDevice {
  name: string
  type?: string
  traits?: Record<string, Record<string, unknown>>
  parentRelations?: { displayName?: string }[]
}

/** Turn an SDM device into what the display needs; null if it isn't a camera. */
export function toCamera(device: SdmDevice): NestCameraDto | null {
  const live = device.traits?.[LIVE_TRAIT]
  if (!live) return null
  const id = device.name.split('/').pop() ?? ''
  if (!DEVICE_ID.test(id)) return null
  const protocols = Array.isArray(live.supportedProtocols) ? (live.supportedProtocols as string[]) : []
  const custom = (device.traits?.['sdm.devices.traits.Info']?.customName as string | undefined)?.trim()
  const room = device.parentRelations?.[0]?.displayName?.trim() || null
  const kind = device.type?.endsWith('DOORBELL') ? 'Doorbell' : 'Camera'
  return {
    id,
    name: custom || (room ? `${room} ${kind.toLowerCase()}` : kind),
    room,
    webrtc: protocols.includes('WEB_RTC')
  }
}

/** The partner-connections consent URL (Google's Device Access sign-in page). */
export function buildNestAuthUrl(cfg: NestConfig, state: string): string {
  const q = new URLSearchParams({
    redirect_uri: NEST_REDIRECT,
    access_type: 'offline',
    prompt: 'consent',
    client_id: cfg.clientId,
    response_type: 'code',
    scope: SDM_SCOPE,
    state
  })
  return `https://nestservices.google.com/partnerconnections/${encodeURIComponent(cfg.projectId)}/auth?${q}`
}

/** Google requires the SDP offer to end with a newline. */
export function normalizeOffer(sdp: string): string {
  return sdp.endsWith('\n') ? sdp : `${sdp}\r\n`
}

export function createNestService(deps: { settings: SettingsService; secrets: SecretBox; fetcher?: Fetcher }) {
  const { settings, secrets } = deps
  const fetcher: Fetcher = deps.fetcher ?? ((url, init) => fetch(url, init))
  let pending: { state: string; expiresAt: number } | null = null
  let access: { token: string; expiresAt: number } | null = null
  let devices: { at: number; list: NestCameraDto[] } | null = null
  let lastError: string | null = null

  const readSecret = (key: string): string | null => {
    const b64 = settings.getRaw(key)
    if (!b64) return null
    try {
      return secrets.decrypt(Buffer.from(b64, 'base64'))
    } catch {
      return null
    }
  }
  const writeSecret = (key: string, value: string): void =>
    settings.setRaw(key, secrets.encrypt(value).toString('base64'))

  function getConfig(): (NestConfig & { clientSecret: string }) | null {
    const raw = settings.getRaw(KEY_CONFIG)
    const clientSecret = readSecret(KEY_CLIENT_SECRET)
    if (!raw || !clientSecret) return null
    try {
      const cfg = JSON.parse(raw) as NestConfig
      return { ...cfg, clientSecret }
    } catch {
      return null
    }
  }

  function requireConfig(): NestConfig & { clientSecret: string } {
    const cfg = getConfig()
    if (!cfg) throw new AppError('NOT_CONFIGURED', 'Enter your Device Access project ID and OAuth client first')
    return cfg
  }

  function getStatus(): NestStatusDto {
    const cfg = getConfig()
    return {
      configured: !!cfg,
      connected: !!cfg && !!settings.getRaw(KEY_REFRESH),
      projectId: cfg?.projectId ?? null,
      error: lastError
    }
  }

  function setCredentials(input: { projectId: string; clientId: string; clientSecret: string }): void {
    if (!PROJECT_ID.test(input.projectId.trim())) {
      throw new AppError('INVALID', 'That doesn’t look like a Device Access project ID')
    }
    settings.setRaw(KEY_CONFIG, JSON.stringify({ projectId: input.projectId.trim(), clientId: input.clientId.trim() }))
    writeSecret(KEY_CLIENT_SECRET, input.clientSecret.trim())
    // a new project/client invalidates the old sign-in
    settings.deleteRaw(KEY_REFRESH)
    access = null
    devices = null
    lastError = null
  }

  function beginConnect(): { authUrl: string } {
    const cfg = requireConfig()
    const state = crypto.randomBytes(16).toString('base64url')
    pending = { state, expiresAt: Date.now() + PENDING_TTL_MS }
    return { authUrl: buildNestAuthUrl(cfg, state) }
  }

  async function tokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString()
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const reason = (json.error_description ?? json.error ?? `HTTP ${res.status}`) as string
      throw new AppError('AUTH_FAILED', `Google sign-in failed: ${reason}`)
    }
    return json
  }

  async function finishConnect(pastedUrl: string): Promise<{ cameras: number }> {
    const cfg = requireConfig()
    if (!pending || Date.now() > pending.expiresAt) {
      throw new AppError('AUTH_EXPIRED', 'Sign-in link expired — tap "Get sign-in link" again')
    }
    const { code, state } = parsePastedRedirect(pastedUrl)
    if (state !== pending.state) throw new AppError('INVALID', 'That link is from a different sign-in attempt — start again')
    pending = null
    const tokens = await tokenRequest({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: NEST_REDIRECT,
      grant_type: 'authorization_code'
    })
    if (typeof tokens.refresh_token !== 'string') {
      throw new AppError('AUTH_FAILED', 'Google didn’t return a long-term sign-in. Remove access and try again.')
    }
    writeSecret(KEY_REFRESH, tokens.refresh_token)
    if (typeof tokens.access_token === 'string') {
      access = { token: tokens.access_token, expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000 }
    }
    devices = null
    lastError = null
    return { cameras: (await listCameras()).length }
  }

  function disconnect(): void {
    settings.deleteRaw(KEY_REFRESH)
    access = null
    devices = null
    lastError = null
  }

  async function accessToken(): Promise<string> {
    if (access && Date.now() < access.expiresAt - 60_000) return access.token
    const cfg = requireConfig()
    const refresh = readSecret(KEY_REFRESH)
    if (!refresh) throw new AppError('NOT_CONNECTED', 'Connect your Google Home cameras in Settings first')
    try {
      const tokens = await tokenRequest({
        refresh_token: refresh,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: 'refresh_token'
      })
      access = { token: String(tokens.access_token), expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000 }
      return access.token
    } catch (err) {
      lastError = 'Google sign-in expired — reconnect cameras in Settings'
      throw err
    }
  }

  async function sdm(path: string, init?: { method: 'POST'; body: unknown }): Promise<Record<string, unknown>> {
    const cfg = requireConfig()
    const url = `${SDM_BASE}/enterprises/${encodeURIComponent(cfg.projectId)}${path}`
    const res = await fetcher(url, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(init ? { 'Content-Type': 'application/json' } : {})
      },
      body: init ? JSON.stringify(init.body) : undefined
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const err = json.error as { message?: string; status?: string } | undefined
      if (res.status === 401) access = null
      throw new AppError('CAMERA_ERROR', `Google Home: ${err?.message ?? `HTTP ${res.status}`}`)
    }
    lastError = null
    return json
  }

  async function listCameras(force = false): Promise<NestCameraDto[]> {
    if (!force && devices && Date.now() - devices.at < DEVICE_CACHE_MS) return devices.list
    const json = await sdm('/devices')
    const list = ((json.devices as SdmDevice[] | undefined) ?? [])
      .map(toCamera)
      .filter((c): c is NestCameraDto => c !== null)
    devices = { at: Date.now(), list }
    return list
  }

  const command = (deviceId: string, name: string, params: Record<string, unknown>) => {
    if (!DEVICE_ID.test(deviceId)) throw new AppError('INVALID', 'Unknown camera')
    return sdm(`/devices/${deviceId}:executeCommand`, {
      method: 'POST',
      body: { command: `sdm.devices.commands.CameraLiveStream.${name}`, params }
    }).then((r) => (r.results ?? {}) as Record<string, string>)
  }

  async function startStream(deviceId: string, offerSdp: string) {
    const r = await command(deviceId, 'GenerateWebRtcStream', { offerSdp: normalizeOffer(offerSdp) })
    return { answerSdp: r.answerSdp, mediaSessionId: r.mediaSessionId, expiresAt: r.expiresAt }
  }

  async function extendStream(deviceId: string, mediaSessionId: string) {
    const r = await command(deviceId, 'ExtendWebRtcStream', { mediaSessionId })
    return { mediaSessionId: r.mediaSessionId ?? mediaSessionId, expiresAt: r.expiresAt }
  }

  async function stopStream(deviceId: string, mediaSessionId: string): Promise<void> {
    await command(deviceId, 'StopWebRtcStream', { mediaSessionId })
  }

  return {
    getStatus,
    setCredentials,
    beginConnect,
    finishConnect,
    disconnect,
    listCameras,
    startStream,
    extendStream,
    stopStream
  }
}

export type NestService = ReturnType<typeof createNestService>
