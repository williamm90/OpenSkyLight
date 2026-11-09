import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { WebSocketServer } from 'ws'
import type { IpcChannel, IpcResult } from '@shared/ipc/contract'
import { subscribe } from '../main/bus'
import { DISPLAY_COOKIE, readCookie, type DisplayAuth } from './displayAuth'

/** Avatars arrive as data URLs, so RPC bodies need more room than the companion's 64 KB. */
const MAX_BODY_BYTES = 1024 * 1024
const SSE_HEARTBEAT_MS = 25_000
const PAIR_FAIL_LIMIT = 20
const PAIR_FAIL_WINDOW_MS = 10 * 60_000

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}

const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:"

export interface HttpServerDeps {
  displayAuth: DisplayAuth
  dispatch: (channel: IpcChannel, payload: unknown) => Promise<IpcResult<unknown>>
  /** Built display UI (out/renderer). */
  rendererRoot: string
  /** Current screensaver folder, if any. */
  photoFolder: () => string | null
  albumCacheDir: string
  acceptCameraSocket: (ws: import('ws').WebSocket, req: IncomingMessage) => void
  /** State replayed to each display as it connects (pushes are edge-triggered). */
  initialPushes: () => { channel: string; payload: unknown }[]
  version: string
}

/** Resolve `name` inside `root`, refusing anything that escapes it. */
export function safeJoin(root: string, name: string): string | null {
  const base = resolve(root)
  const full = resolve(join(base, name))
  return full.startsWith(base + sep) ? full : null
}

export function createHttpServer(deps: HttpServerDeps): Server {
  const pairFails = new Map<string, { count: number; windowStart: number }>()

  function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
    res.end(JSON.stringify(body))
  }

  function isPaired(req: IncomingMessage): boolean {
    return deps.displayAuth.verify(readCookie(req.headers.cookie, DISPLAY_COOKIE))
  }

  function readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((done) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          done(null)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => done(null))
    })
  }

  async function readJson(req: IncomingMessage, res: ServerResponse): Promise<{ ok: true; value: unknown } | { ok: false }> {
    const body = await readBody(req)
    if (body === null) {
      sendJson(res, 413, { ok: false, error: { code: 'TOO_LARGE', message: 'Request too large' } })
      return { ok: false }
    }
    try {
      return { ok: true, value: body.trim() === '' ? undefined : JSON.parse(body) }
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'INVALID', message: 'Body must be JSON' } })
      return { ok: false }
    }
  }

  function pairRateLimited(ip: string): boolean {
    const entry = pairFails.get(ip)
    return !!entry && Date.now() - entry.windowStart < PAIR_FAIL_WINDOW_MS && entry.count >= PAIR_FAIL_LIMIT
  }

  function recordPairFail(ip: string): void {
    const now = Date.now()
    const entry = pairFails.get(ip)
    if (!entry || now - entry.windowStart > PAIR_FAIL_WINDOW_MS) pairFails.set(ip, { count: 1, windowStart: now })
    else entry.count += 1
    if (pairFails.size > 1000) pairFails.clear()
  }

  async function handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? 'unknown'
    if (pairRateLimited(ip)) {
      sendJson(res, 429, { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many tries — wait a few minutes' } })
      return
    }
    const parsed = await readJson(req, res)
    if (!parsed.ok) return
    const code = (parsed.value as { code?: unknown })?.code
    const result = deps.displayAuth.redeem(typeof code === 'string' ? code : '')
    if ('error' in result) {
      recordPairFail(ip)
      sendJson(res, 400, { ok: false, error: { code: 'BAD_CODE', message: result.error } })
      return
    }
    sendJson(res, 200, { ok: true, data: null }, { 'Set-Cookie': deps.displayAuth.cookieFor(result.token, false) })
  }

  async function handleRpc(req: IncomingMessage, res: ServerResponse, channelRaw: string): Promise<void> {
    // custom header = no cross-site form posts, on top of the SameSite cookie
    if (req.headers['x-osl'] !== '1') {
      sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Missing client header' } })
      return
    }
    const parsed = await readJson(req, res)
    if (!parsed.ok) return
    const result = await deps.dispatch(decodeURIComponent(channelRaw) as IpcChannel, parsed.value)
    sendJson(res, 200, result)
  }

  function handleEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    const send = (channel: string, payload: unknown): void => {
      res.write(`data: ${JSON.stringify({ channel, payload })}\n\n`)
    }
    res.write('retry: 3000\n\n')
    for (const p of deps.initialPushes()) send(p.channel, p.payload)
    const unsubscribe = subscribe(send)
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS)
    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  }

  async function serveFile(res: ServerResponse, filePath: string, cache: string): Promise<void> {
    let data: Buffer
    try {
      data = await fs.readFile(filePath)
    } catch {
      res.writeHead(404).end('Not found')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': cache })
    res.end(data)
  }

  async function serveMedia(res: ServerResponse, root: string | null, rawName: string): Promise<void> {
    const full = root ? safeJoin(root, decodeURIComponent(rawName)) : null
    if (!full) {
      res.writeHead(404).end()
      return
    }
    await serveFile(res, full, 'private, max-age=86400')
  }

  async function proxyBird(res: ServerResponse, url: URL): Promise<void> {
    const base = url.searchParams.get('base') ?? ''
    const sci = url.searchParams.get('sci') ?? ''
    if (!/^https?:\/\/[^/]+$/i.test(base) || sci === '') {
      res.writeHead(400).end()
      return
    }
    try {
      const upstream = await fetch(`${base}/media/image/${encodeURIComponent(sci)}`, { signal: AbortSignal.timeout(10_000) })
      if (!upstream.ok) {
        res.writeHead(upstream.status).end()
        return
      }
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') ?? 'image/jpeg',
        'Cache-Control': 'private, max-age=3600'
      })
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch {
      res.writeHead(502).end()
    }
  }

  async function serveApp(res: ServerResponse, pathname: string): Promise<void> {
    const isAsset = pathname !== '/' && extname(pathname) !== ''
    const full = isAsset ? safeJoin(deps.rendererRoot, decodeURIComponent(pathname)) : null
    if (isAsset) {
      if (!full) {
        res.writeHead(404).end()
        return
      }
      const cache = pathname.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
      await serveFile(res, full, cache)
      return
    }
    // SPA shell for every non-asset path
    try {
      const html = await fs.readFile(join(deps.rendererRoot, 'index.html'))
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP })
      res.end(html)
    } catch {
      res.writeHead(500).end('Display UI not built — run `npm run build` first')
    }
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (path === '/api/health') return sendJson(res, 200, { app: 'openskylight', mode: 'server', version: deps.version })
    if (path === '/api/display/status' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, data: { paired: isPaired(req) } })
    }
    if (path === '/api/display/pair' && req.method === 'POST') return handlePair(req, res)

    // everything below requires a paired display
    const needsAuth = path.startsWith('/api/') || path.startsWith('/media/')
    if (needsAuth && !isPaired(req)) {
      return sendJson(res, 401, { ok: false, error: { code: 'UNPAIRED', message: 'This screen isn’t paired yet' } })
    }

    const rpc = path.match(/^\/api\/rpc\/([^/]+)$/)
    if (rpc) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } })
      return handleRpc(req, res, rpc[1])
    }
    if (path === '/api/events' && req.method === 'GET') return handleEvents(req, res)
    if (path.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } })

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    if (path.startsWith('/media/photos/')) return serveMedia(res, deps.photoFolder(), path.slice('/media/photos/'.length))
    if (path.startsWith('/media/album/')) return serveMedia(res, deps.albumCacheDir, path.slice('/media/album/'.length))
    if (path === '/media/bird') return proxyBird(res, url)
    return serveApp(res, path)
  }

  const server = createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      console.error('[http]', err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })

  // camera streams ride the same port so the tablet only ever talks to one address
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/ws/camera/') || !isPaired(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => deps.acceptCameraSocket(ws, req))
  })
  server.on('close', () => wss.close())

  return server
}
