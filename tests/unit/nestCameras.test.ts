import { describe, expect, it } from 'vitest'
import { buildNestAuthUrl, createNestService, normalizeOffer, toCamera, NEST_REDIRECT } from '../../src/main/services/nestService'
import { extendDelayMs, shouldStream } from '../../src/shared/nestStream'
import { sanitizeLayout } from '../../src/shared/home'
import { nestStartSchema, settingsPatchSchema } from '../../src/shared/ipc/schemas'
import type { SettingsService } from '../../src/main/services/settingsService'
import type { SecretBox } from '../../src/main/secretBox'

const PROJECT = 'abcd1234-5678-90ef-aaaa-bbbbccccdddd'
const DEVICE = 'AVPHwEuDEVICE_id-123456'

function settingsStub(): SettingsService & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    getRaw: (key: string) => store.get(key) ?? null,
    setRaw: (key: string, value: string) => void store.set(key, value),
    deleteRaw: (key: string) => void store.delete(key),
    getAll: () => ({}) as never,
    set: () => ({}) as never
  } as unknown as SettingsService & { store: Map<string, string> }
}

// reversible stand-in so tests can prove nothing is stored in the clear
const secrets: SecretBox = {
  encrypt: (s) => Buffer.from(`enc:${[...s].reverse().join('')}`),
  decrypt: (b) => [...b.toString().slice(4)].reverse().join('')
}

interface Call {
  url: string
  init?: RequestInit
}

function fakeGoogle(handlers: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = []
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    const key = Object.keys(handlers).find((k) => url.includes(k))
    if (!key) return new Response(JSON.stringify({ error: { message: 'not mocked' } }), { status: 404 })
    const body = handlers[key]({ url, init })
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200 })
  }
  return { calls, fetcher }
}

const devicesResponse = {
  devices: [
    {
      name: `enterprises/${PROJECT}/devices/${DEVICE}`,
      type: 'sdm.devices.types.DOORBELL',
      traits: {
        'sdm.devices.traits.Info': { customName: '' },
        'sdm.devices.traits.CameraLiveStream': { supportedProtocols: ['WEB_RTC'] }
      },
      parentRelations: [{ displayName: 'Front door' }]
    },
    {
      name: `enterprises/${PROJECT}/devices/OLDCAM-0000001`,
      type: 'sdm.devices.types.CAMERA',
      traits: {
        'sdm.devices.traits.Info': { customName: 'Nursery' },
        'sdm.devices.traits.CameraLiveStream': { supportedProtocols: ['RTSP'] }
      }
    },
    { name: `enterprises/${PROJECT}/devices/THERMOSTAT-01`, type: 'sdm.devices.types.THERMOSTAT', traits: {} }
  ]
}

async function connected() {
  const settings = settingsStub()
  const google = fakeGoogle({
    'oauth2.googleapis.com/token': ({ init }) => {
      const body = new URLSearchParams(String(init?.body))
      return body.get('grant_type') === 'authorization_code'
        ? { access_token: 'at-1', refresh_token: 'rt-secret', expires_in: 3600 }
        : { access_token: 'at-2', expires_in: 3600 }
    },
    '/devices:': () => ({}),
    ':executeCommand': ({ init }) => {
      const { command } = JSON.parse(String(init?.body)) as { command: string }
      if (command.endsWith('GenerateWebRtcStream')) {
        return { results: { answerSdp: 'v=0 answer', mediaSessionId: 'ms-1', expiresAt: '2026-11-07T10:05:00Z' } }
      }
      if (command.endsWith('ExtendWebRtcStream')) {
        return { results: { mediaSessionId: 'ms-2', expiresAt: '2026-11-07T10:10:00Z' } }
      }
      return {}
    },
    '/devices': () => devicesResponse
  })
  const nest = createNestService({ settings, secrets, fetcher: google.fetcher })
  nest.setCredentials({ projectId: PROJECT, clientId: 'client-123.apps.googleusercontent.com', clientSecret: 'shh-secret' })
  const { authUrl } = nest.beginConnect()
  const state = new URL(authUrl).searchParams.get('state')!
  const result = await nest.finishConnect(`${NEST_REDIRECT}/?state=${state}&code=4/abc&scope=x`)
  return { settings, google, nest, result }
}

describe('Google Home cameras: sign-in', () => {
  it('builds the Device Access consent link', () => {
    const url = new URL(buildNestAuthUrl({ projectId: PROJECT, clientId: 'cid' }, 'st'))
    expect(url.origin + url.pathname).toBe(`https://nestservices.google.com/partnerconnections/${PROJECT}/auth`)
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/sdm.service')
    expect(url.searchParams.get('redirect_uri')).toBe('https://www.google.com')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('state')).toBe('st')
  })

  it('exchanges the pasted code and stores tokens encrypted', async () => {
    const { settings, result, nest } = await connected()
    expect(result.cameras).toBe(2)
    expect(nest.getStatus()).toMatchObject({ configured: true, connected: true, projectId: PROJECT, error: null })
    const stored = [...settings.store.values()].join('\n')
    expect(stored).not.toContain('rt-secret')
    expect(stored).not.toContain('shh-secret')
  })

  it('rejects a pasted link from a different attempt', async () => {
    const nest = createNestService({ settings: settingsStub(), secrets, fetcher: fakeGoogle({}).fetcher })
    nest.setCredentials({ projectId: PROJECT, clientId: 'client-123', clientSecret: 'x-secret' })
    nest.beginConnect()
    await expect(nest.finishConnect('https://www.google.com/?state=wrong&code=4/abc')).rejects.toThrow(/different sign-in/)
  })

  it('refuses a malformed project id', () => {
    const nest = createNestService({ settings: settingsStub(), secrets })
    expect(() => nest.setCredentials({ projectId: '../evil', clientId: 'client-123', clientSecret: 'x-secret' })).toThrow()
  })

  it('disconnecting forgets the sign-in', async () => {
    const { nest } = await connected()
    nest.disconnect()
    expect(nest.getStatus().connected).toBe(false)
    await expect(nest.listCameras(true)).rejects.toThrow(/Connect your Google Home cameras/)
  })
})

describe('Google Home cameras: devices and streams', () => {
  it('lists only cameras, naming them sensibly', async () => {
    const { nest } = await connected()
    expect(await nest.listCameras()).toEqual([
      { id: DEVICE, name: 'Front door doorbell', room: 'Front door', webrtc: true },
      { id: 'OLDCAM-0000001', name: 'Nursery', room: null, webrtc: false }
    ])
  })

  it('ignores devices with odd ids', () => {
    expect(
      toCamera({ name: 'enterprises/p/devices/../../x', traits: { 'sdm.devices.traits.CameraLiveStream': {} } })
    ).toBeNull()
  })

  it('starts, extends and stops a WebRTC stream with the right commands', async () => {
    const { nest, google } = await connected()
    const started = await nest.startStream(DEVICE, 'v=0\r\nm=audio')
    expect(started).toEqual({ answerSdp: 'v=0 answer', mediaSessionId: 'ms-1', expiresAt: '2026-11-07T10:05:00Z' })
    const extended = await nest.extendStream(DEVICE, 'ms-1')
    expect(extended.mediaSessionId).toBe('ms-2')
    await nest.stopStream(DEVICE, 'ms-2')

    const commands = google.calls
      .filter((c) => c.url.endsWith(':executeCommand'))
      .map((c) => JSON.parse(String(c.init?.body)) as { command: string; params: Record<string, string> })
    expect(commands.map((c) => c.command.split('.').pop())).toEqual([
      'GenerateWebRtcStream',
      'ExtendWebRtcStream',
      'StopWebRtcStream'
    ])
    expect(commands[0].params.offerSdp.endsWith('\n')).toBe(true)
    const auth = (google.calls.at(-1)!.init!.headers as Record<string, string>).Authorization
    expect(auth).toBe('Bearer at-1')
    expect(google.calls.at(-1)!.url).toBe(
      `https://smartdevicemanagement.googleapis.com/v1/enterprises/${PROJECT}/devices/${DEVICE}:executeCommand`
    )
  })

  it('surfaces Google errors in plain words', async () => {
    const settings = settingsStub()
    const google = fakeGoogle({
      'oauth2.googleapis.com/token': () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
      ':executeCommand': () =>
        new Response(JSON.stringify({ error: { message: 'Rate limited' } }), { status: 429 }),
      '/devices': () => ({ devices: [] })
    })
    const nest = createNestService({ settings, secrets, fetcher: google.fetcher })
    nest.setCredentials({ projectId: PROJECT, clientId: 'client-123', clientSecret: 'x-secret' })
    const state = new URL(nest.beginConnect().authUrl).searchParams.get('state')!
    await nest.finishConnect(`https://www.google.com/?state=${state}&code=c`)
    await expect(nest.startStream(DEVICE, 'v=0\n')).rejects.toThrow('Google Home: Rate limited')
  })

  it('adds the trailing newline Google requires', () => {
    expect(normalizeOffer('v=0')).toBe('v=0\r\n')
    expect(normalizeOffer('v=0\n')).toBe('v=0\n')
  })
})

describe('Google Home cameras: tile behaviour', () => {
  it('extends 30 seconds before expiry, never sooner than 5 seconds', () => {
    const now = Date.parse('2026-11-07T10:00:00Z')
    expect(extendDelayMs('2026-11-07T10:05:00Z', now)).toBe(270_000)
    expect(extendDelayMs('2026-11-07T10:00:10Z', now)).toBe(5_000)
    expect(extendDelayMs('not a date', now)).toBe(240_000)
  })

  it('streams only when it should', () => {
    expect(shouldStream({ mode: 'tap', tapped: false, covered: false, webrtc: true })).toBe(false)
    expect(shouldStream({ mode: 'tap', tapped: true, covered: false, webrtc: true })).toBe(true)
    expect(shouldStream({ mode: 'always', tapped: false, covered: false, webrtc: true })).toBe(true)
    expect(shouldStream({ mode: 'always', tapped: true, covered: true, webrtc: true })).toBe(false) // screensaver / sleep
    expect(shouldStream({ mode: 'always', tapped: true, covered: false, webrtc: false })).toBe(false) // RTSP-only camera
  })

  it('keeps a camera tile’s device id through layout cleanup', () => {
    const [tile] = sanitizeLayout([
      { id: 't1', type: 'nestCamera', x: 0, y: 0, w: 4, h: 3, config: { nestDeviceId: DEVICE, listId: 'smuggled' } }
    ])
    expect(tile.config).toEqual({ nestDeviceId: DEVICE })
  })

  it('validates stream requests and camera settings', () => {
    expect(nestStartSchema.safeParse({ deviceId: DEVICE, offerSdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1' }).success).toBe(true)
    expect(nestStartSchema.safeParse({ deviceId: '../x', offerSdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1' }).success).toBe(false)
    expect(
      settingsPatchSchema.safeParse({ patch: { cameras: { open: 'app', requirePin: true, live: 'always' } } }).success
    ).toBe(true)
  })
})
