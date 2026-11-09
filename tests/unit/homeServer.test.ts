import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createDisplayAuth, readCookie } from '../../src/server/displayAuth'
import { createHttpServer, safeJoin } from '../../src/server/httpServer'
import { broadcast } from '../../src/main/bus'
import type { SettingsService } from '../../src/main/services/settingsService'

function settingsStub(): SettingsService {
  const store = new Map<string, string>()
  return {
    getRaw: (key: string) => store.get(key) ?? null,
    setRaw: (key: string, value: string) => void store.set(key, value),
    deleteRaw: (key: string) => void store.delete(key),
    getAll: () => ({}) as never,
    set: () => ({}) as never
  } as SettingsService
}

describe('display pairing', () => {
  it('a code works once and yields a token that verifies', () => {
    const auth = createDisplayAuth(settingsStub())
    const { code } = auth.issueCode()
    expect(code).toMatch(/^\d{6}$/)
    const result = auth.redeem(code)
    expect('token' in result && auth.verify(result.token)).toBe(true)
    expect('error' in auth.redeem(code)).toBe(true) // single use
    expect(auth.pairedCount()).toBe(1)
  })
  it('burns the code after too many wrong guesses', () => {
    const auth = createDisplayAuth(settingsStub())
    const { code } = auth.issueCode()
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < 10; i++) auth.redeem(wrong)
    expect('error' in auth.redeem(code)).toBe(true)
  })
  it('display tokens are separate from companion phone tokens', () => {
    const settings = settingsStub()
    const auth = createDisplayAuth(settings)
    const r = auth.redeem(auth.issueCode().code)
    expect(settings.getRaw('companion.tokens.v1')).toBeNull()
    expect('token' in r).toBe(true)
  })
  it('reads cookies', () => {
    expect(readCookie('a=1; osl_display=tok%2Fx; b=2', 'osl_display')).toBe('tok/x')
    expect(readCookie(undefined, 'osl_display')).toBeUndefined()
  })
})

describe('safeJoin', () => {
  it('refuses paths that escape the root', () => {
    const root = join(tmpdir(), 'root')
    expect(safeJoin(root, 'a.jpg')).toBe(join(root, 'a.jpg'))
    expect(safeJoin(root, '../secret.key')).toBeNull()
    expect(safeJoin(root, '..\\..\\x')).toBeNull()
    expect(safeJoin(join(tmpdir(), 'ro'), '../root/a.jpg')).toBeNull()
  })
})

describe('home server HTTP', () => {
  let server: Server | null = null
  const dirs: string[] = []
  afterEach(() => {
    server?.close()
    server = null
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  async function start(): Promise<{ base: string; auth: ReturnType<typeof createDisplayAuth>; dispatched: string[] }> {
    const root = mkdtempSync(join(tmpdir(), 'osl-srv-'))
    dirs.push(root)
    const renderer = join(root, 'renderer')
    const album = join(root, 'album')
    mkdirSync(renderer)
    mkdirSync(album)
    writeFileSync(join(renderer, 'index.html'), '<html>app</html>')
    writeFileSync(join(album, 'p1.jpg'), 'jpeg-bytes')
    writeFileSync(join(root, 'secret.key'), 'do-not-serve')
    const auth = createDisplayAuth(settingsStub())
    const dispatched: string[] = []
    server = createHttpServer({
      displayAuth: auth,
      dispatch: async (channel, payload) => {
        dispatched.push(channel)
        return { ok: true, data: { channel, payload } }
      },
      rendererRoot: renderer,
      photoFolder: () => null,
      albumCacheDir: album,
      acceptCameraSocket: () => undefined,
      initialPushes: () => [{ channel: 'push:sleepState', payload: { sleeping: false } }],
      version: 'test'
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server!.address() as AddressInfo
    return { base: `http://127.0.0.1:${port}`, auth, dispatched }
  }

  async function pair(base: string, auth: ReturnType<typeof createDisplayAuth>): Promise<string> {
    const { code } = auth.issueCode()
    const res = await fetch(`${base}/api/display/pair`, { method: 'POST', body: JSON.stringify({ code }) })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    return cookie.split(';')[0]
  }

  it('serves the app shell to anyone, but data only to paired screens', async () => {
    const { base, auth, dispatched } = await start()
    const shell = await fetch(`${base}/`)
    expect(await shell.text()).toBe('<html>app</html>')
    expect(shell.headers.get('content-security-policy')).toContain("default-src 'self'")

    const status = (await (await fetch(`${base}/api/display/status`)).json()) as { data: { paired: boolean } }
    expect(status.data.paired).toBe(false)

    const denied = await fetch(`${base}/api/rpc/people:list`, { method: 'POST', headers: { 'X-OSL': '1' } })
    expect(denied.status).toBe(401)
    expect((await fetch(`${base}/media/album/p1.jpg`)).status).toBe(401)
    expect(dispatched).toEqual([])

    const cookie = await pair(base, auth)
    const ok = await fetch(`${base}/api/rpc/people:list`, {
      method: 'POST',
      headers: { 'X-OSL': '1', Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1 })
    })
    expect(await ok.json()).toEqual({ ok: true, data: { channel: 'people:list', payload: { a: 1 } } })
    const photo = await fetch(`${base}/media/album/p1.jpg`, { headers: { Cookie: cookie } })
    expect(await photo.text()).toBe('jpeg-bytes')
  })

  it('rejects RPC without the client header (no cross-site form posts)', async () => {
    const { base, auth } = await start()
    const cookie = await pair(base, auth)
    const res = await fetch(`${base}/api/rpc/people:list`, { method: 'POST', headers: { Cookie: cookie } })
    expect(res.status).toBe(403)
  })

  it('never serves files outside the media folders', async () => {
    const { base, auth } = await start()
    const cookie = await pair(base, auth)
    const res = await fetch(`${base}/media/album/..%2Fsecret.key`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(404)
  })

  it('streams pushes over Server-Sent Events, starting with current state', async () => {
    const { base, auth } = await start()
    const cookie = await pair(base, auth)
    const controller = new AbortController()
    const res = await fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (needle: string): Promise<void> => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value)
      }
    }
    await readUntil('push:sleepState')
    broadcast('push:dataChanged', { domain: 'chores' })
    await readUntil('push:dataChanged')
    expect(text).toContain('"domain":"chores"')
    controller.abort()
  })
})
