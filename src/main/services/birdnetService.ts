import { invalid } from './errors'
import type { IpcContract } from '@shared/ipc/contract'

type BirdNetDto = IpcContract['birdnet:getDetections']['res']
type Detection = BirdNetDto['detections'][number]

const CACHE_TTL_MS = 15 * 1000 // tile polls every 20s; a short cache de-dupes multiple tiles
const FETCH_TIMEOUT_MS = 10_000
const MAX_ITEMS = 12

/** Reduce any pasted BirdNET-Go URL (dashboard, trailing path, etc.) to its origin. */
export function normalizeBirdnetUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw invalid('That doesn’t look like a URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalid('URL must start with http:// or https://')
  }
  return parsed.origin
}

export type BirdImageUrl = (origin: string, scientificName: string) => string

/** osl-bird:// proxy URL so the sandboxed renderer loads the photo via the main process. */
export const electronBirdImageUrl: BirdImageUrl = (origin, scientificName) =>
  `osl-bird://image?base=${encodeURIComponent(origin)}&sci=${encodeURIComponent(scientificName)}`

/** Same-origin HTTP proxy path used by the headless server. */
export const httpBirdImageUrl: BirdImageUrl = (origin, scientificName) =>
  `/media/bird?base=${encodeURIComponent(origin)}&sci=${encodeURIComponent(scientificName)}`

/** Pure: map BirdNET-Go's /api/v2/detections JSON into our DTO list. Never throws. */
export function parseDetections(
  json: unknown,
  origin: string,
  limit = MAX_ITEMS,
  imageUrl: BirdImageUrl = electronBirdImageUrl
): Detection[] {
  const rows = (json as { data?: unknown })?.data
  if (!Array.isArray(rows)) return []
  const out: Detection[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const commonName = typeof r.commonName === 'string' ? r.commonName : null
    const scientificName = typeof r.scientificName === 'string' ? r.scientificName : ''
    const timestamp = typeof r.timestamp === 'string' ? r.timestamp : null
    if (!commonName || !timestamp) continue
    out.push({
      id: typeof r.id === 'number' ? r.id : 0,
      commonName,
      scientificName,
      confidence: typeof r.confidence === 'number' ? r.confidence : 0,
      timestamp,
      image: scientificName ? imageUrl(origin, scientificName) : ''
    })
    if (out.length >= limit) break
  }
  return out
}

export function createBirdNetService(imageUrl: BirdImageUrl = electronBirdImageUrl) {
  const cache = new Map<string, { data: BirdNetDto; atMs: number }>()

  async function getDetections(rawUrl: string): Promise<BirdNetDto> {
    const origin = normalizeBirdnetUrl(rawUrl)

    const cached = cache.get(origin)
    if (cached && Date.now() - cached.atMs < CACHE_TTL_MS) return cached.data

    try {
      const res = await fetch(`${origin}/api/v2/detections?numResults=${MAX_ITEMS}&sortBy=date_desc`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json', 'User-Agent': 'OpenSkyLight/1.0 (family calendar display)' }
      })
      if (!res.ok) throw new Error(`BirdNET-Go returned HTTP ${res.status}`)
      const detections = parseDetections(await res.json(), origin, MAX_ITEMS, imageUrl)
      const data: BirdNetDto = { url: origin, label: 'Birds', detections, fetchedAt: new Date().toISOString() }
      cache.set(origin, { data, atMs: Date.now() })
      return data
    } catch (err) {
      if (cached) return cached.data // serve stale over an error
      throw err
    }
  }

  return { getDetections }
}

export type BirdNetService = ReturnType<typeof createBirdNetService>
