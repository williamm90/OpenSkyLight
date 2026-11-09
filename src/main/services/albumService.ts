import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { SettingsService } from './settingsService'
import { invalid } from './errors'

/**
 * Family photos from an iCloud **shared album** with "Public Website" turned
 * on. Uses the same JSON endpoints the icloud.com album page uses (not an
 * official API, but stable for years and used widely by photo-frame projects).
 * Photos are downloaded into a local cache so the display never depends on
 * Apple's short-lived CDN links.
 */

const REFRESH_MS = 30 * 60 * 1000
const FIRST_REFRESH_DELAY_MS = 5_000
const FETCH_TIMEOUT_MS = 30_000
const MAX_PHOTOS = 300
const MAX_WIDTH = 2048
const ASSET_BATCH = 25
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface AlbumStatus {
  configured: boolean
  name: string | null
  photoCount: number
  lastSyncedAt: string | null
  lastError: string | null
  syncing: boolean
}

/** Pull the album token out of a pasted share link (or accept a bare token). */
export function parseAlbumToken(raw: string): string {
  const text = raw.trim()
  const hashIdx = text.indexOf('#')
  const token = hashIdx >= 0 ? text.slice(hashIdx + 1) : text
  const clean = token.split(/[;?&/]/)[0]
  if (!/^[A-Za-z0-9]{10,}$/.test(clean)) {
    throw invalid('Paste the shared album’s public link — it looks like https://www.icloud.com/sharedalbum/#B0…')
  }
  return clean
}

function base62ToInt(s: string): number {
  let n = 0
  for (const ch of s) n = n * 62 + BASE62.indexOf(ch)
  return n
}

/** Apple shards albums across hosts; the shard is encoded in the token. */
export function albumBaseUrl(token: string, host?: string): string {
  if (host) return `https://${host}/${token}/sharedstreams/`
  const partition = token[0] === 'A' ? base62ToInt(token[1]) : base62ToInt(token.slice(1, 3))
  return `https://p${String(partition).padStart(2, '0')}-sharedstreams.icloud.com/${token}/sharedstreams/`
}

export interface AlbumPhoto {
  guid: string
  /** checksum of the chosen derivative — the key into webasseturls */
  checksum: string
  createdAt: string | null
}

/** Pure: choose the best still-image derivative per photo, newest first. */
export function pickPhotos(stream: unknown, limit = MAX_PHOTOS): { name: string | null; photos: AlbumPhoto[] } {
  const s = stream as { streamName?: unknown; photos?: unknown }
  const name = typeof s?.streamName === 'string' ? s.streamName : null
  const out: AlbumPhoto[] = []
  if (!Array.isArray(s?.photos)) return { name, photos: out }
  for (const p of s.photos as Record<string, unknown>[]) {
    if (!p || typeof p !== 'object') continue
    if (p.mediaAssetType === 'video') continue
    const guid = typeof p.photoGuid === 'string' ? p.photoGuid : null
    const derivatives = p.derivatives as Record<string, { checksum?: string; width?: string | number }> | undefined
    if (!guid || !derivatives) continue
    let best: { checksum: string; width: number } | null = null
    let smallestOver: { checksum: string; width: number } | null = null
    for (const d of Object.values(derivatives)) {
      if (!d?.checksum) continue
      const width = Number(d.width ?? 0)
      if (width <= MAX_WIDTH) {
        if (!best || width > best.width) best = { checksum: d.checksum, width }
      } else if (!smallestOver || width < smallestOver.width) {
        smallestOver = { checksum: d.checksum, width }
      }
    }
    const chosen = best ?? smallestOver
    if (!chosen) continue
    out.push({ guid, checksum: chosen.checksum, createdAt: typeof p.dateCreated === 'string' ? p.dateCreated : null })
  }
  out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  return { name, photos: out.slice(0, limit) }
}

/** Pure: map webasseturls `items` to downloadable URLs keyed by checksum. */
export function assetUrls(json: unknown): Map<string, string> {
  const items = (json as { items?: Record<string, { url_location?: string; url_path?: string }> })?.items ?? {}
  const out = new Map<string, string>()
  for (const [checksum, item] of Object.entries(items)) {
    if (item?.url_location && item?.url_path) out.set(checksum, `https://${item.url_location}${item.url_path}`)
  }
  return out
}

const safeName = (guid: string): string => `${guid.replace(/[^A-Za-z0-9-]/g, '')}.jpg`

export function createAlbumService(deps: {
  settings: Pick<SettingsService, 'getAll'>
  cacheDir: string
  broadcast: (channel: string, payload: unknown) => void
  fetcher?: Fetcher
}) {
  const fetcher: Fetcher = deps.fetcher ?? ((url, init) => fetch(url, init))
  let timer: NodeJS.Timeout | null = null
  let syncing: Promise<void> | null = null
  let files: string[] = []
  const status: AlbumStatus = {
    configured: false,
    name: null,
    photoCount: 0,
    lastSyncedAt: null,
    lastError: null,
    syncing: false
  }

  async function post(url: string, body: unknown): Promise<Response> {
    return fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://www.icloud.com' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
  }

  /** POST webstream, following Apple's 330 "wrong shard" redirect once. */
  async function fetchStream(token: string): Promise<{ base: string; stream: unknown }> {
    let base = albumBaseUrl(token)
    let res = await post(`${base}webstream`, { streamCtag: null })
    if (res.status === 330) {
      const body = (await res.json()) as Record<string, string>
      const host = body['X-Apple-MMe-Host']
      if (!host) throw new Error('iCloud redirected without a host')
      base = albumBaseUrl(token, host)
      res = await post(`${base}webstream`, { streamCtag: null })
    }
    if (res.status === 404) throw new Error('Album not found — is “Public Website” turned on for this shared album?')
    if (!res.ok) throw new Error(`iCloud returned HTTP ${res.status}`)
    return { base, stream: await res.json() }
  }

  async function readCache(): Promise<string[]> {
    try {
      return (await fs.readdir(deps.cacheDir)).filter((f) => f.endsWith('.jpg')).sort()
    } catch {
      return []
    }
  }

  async function syncOnce(): Promise<void> {
    const albumUrl = deps.settings.getAll().album.url
    status.configured = !!albumUrl
    if (!albumUrl) {
      files = []
      status.photoCount = 0
      return
    }
    const token = parseAlbumToken(albumUrl)
    const { base, stream } = await fetchStream(token)
    const { name, photos } = pickPhotos(stream)
    status.name = name

    await fs.mkdir(deps.cacheDir, { recursive: true })
    const have = new Set(await readCache())
    const missing = photos.filter((p) => !have.has(safeName(p.guid)))

    for (let i = 0; i < missing.length; i += ASSET_BATCH) {
      const batch = missing.slice(i, i + ASSET_BATCH)
      const res = await post(`${base}webasseturls`, { photoGuids: batch.map((p) => p.guid) })
      if (!res.ok) throw new Error(`iCloud asset lookup failed (HTTP ${res.status})`)
      const urls = assetUrls(await res.json())
      for (const photo of batch) {
        const url = urls.get(photo.checksum)
        if (!url) continue
        const img = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (!img.ok) continue
        const target = join(deps.cacheDir, safeName(photo.guid))
        await fs.writeFile(`${target}.part`, Buffer.from(await img.arrayBuffer()))
        await fs.rename(`${target}.part`, target)
      }
    }

    // drop photos that were removed from the album
    const keep = new Set(photos.map((p) => safeName(p.guid)))
    for (const file of await readCache()) {
      if (!keep.has(file)) await fs.rm(join(deps.cacheDir, file), { force: true })
    }
    // newest first, matching the album
    const present = new Set(await readCache())
    files = photos.map((p) => safeName(p.guid)).filter((f) => present.has(f))
    status.photoCount = files.length
  }

  function refresh(): Promise<void> {
    if (syncing) return syncing
    status.syncing = true
    syncing = syncOnce()
      .then(() => {
        status.lastError = null
        status.lastSyncedAt = new Date().toISOString()
      })
      .catch((err: unknown) => {
        status.lastError = err instanceof Error ? err.message : String(err)
        console.error('[album]', status.lastError)
      })
      .finally(() => {
        status.syncing = false
        syncing = null
        deps.broadcast('push:dataChanged', { domain: 'photos' })
      })
    return syncing
  }

  async function start(): Promise<void> {
    files = await readCache() // show cached photos immediately, even offline
    status.photoCount = files.length
    status.configured = !!deps.settings.getAll().album.url
    setTimeout(() => void refresh(), FIRST_REFRESH_DELAY_MS)
    timer = setInterval(() => void refresh(), REFRESH_MS)
  }

  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
  }

  /** Cached file names, newest first; each runtime maps them to URLs. */
  function listFiles(): string[] {
    return deps.settings.getAll().album.url ? [...files] : []
  }

  function getStatus(): AlbumStatus {
    return { ...status }
  }

  return { start, stop, refresh, listFiles, getStatus }
}

export type AlbumService = ReturnType<typeof createAlbumService>
