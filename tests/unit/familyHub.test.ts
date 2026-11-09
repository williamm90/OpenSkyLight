import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGoogleHomeLink, GOOGLE_HOME_PACKAGE, needsPinForCameras } from '../../src/shared/googleHome'
import { buildCallLink, formatPhone, GOOGLE_VOICE_PACKAGE } from '../../src/shared/callLink'
import { cardState, stickerFor, MAX_SPOTS } from '../../src/shared/stickers'
import { normalizeFeedUrl } from '../../src/shared/feedUrl'
import { icsAddSchema, contactCreateSchema, personUpdateSchema } from '../../src/shared/ipc/schemas'
import { normalizePhone, createContactsService } from '../../src/main/services/contactsService'
import { createFileKeySecretBox } from '../../src/main/secretBox'
import { parsePastedRedirect } from '../../src/main/sync/googleAuth'
import {
  albumBaseUrl,
  assetUrls,
  createAlbumService,
  parseAlbumToken,
  pickPhotos,
  type Fetcher
} from '../../src/main/services/albumService'
import { openDatabase } from '../../src/main/db/client'
import { createPeopleService } from '../../src/main/services/peopleService'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'osl-hub-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('call links', () => {
  it('builds a plain tel: link', () => {
    expect(buildCallLink('+1 (555) 123-4567', 'tel')).toBe('tel:+15551234567')
  })
  it('builds a Google Voice intent with a tel: fallback', () => {
    const link = buildCallLink('+15551234567', 'googleVoice')
    expect(link.startsWith('intent:+15551234567#Intent;scheme=tel;')).toBe(true)
    expect(link).toContain(`package=${GOOGLE_VOICE_PACKAGE};`)
    expect(link).toContain('S.browser_fallback_url=tel%3A%2B15551234567')
    expect(link.endsWith(';end')).toBe(true)
  })
  it('formats North American numbers for display', () => {
    expect(formatPhone('+15551234567')).toBe('(555) 123-4567')
    expect(formatPhone('+442071234567')).toBe('+442071234567')
  })
})

describe('normalizePhone', () => {
  it('assumes +1 for bare 10-digit numbers and keeps explicit country codes', () => {
    expect(normalizePhone('555-123-4567')).toBe('+15551234567')
    expect(normalizePhone('1 555 123 4567')).toBe('+15551234567')
    expect(normalizePhone('+44 20 7123 4567')).toBe('+442071234567')
  })
  it('rejects too-short and too-long numbers', () => {
    expect(() => normalizePhone('12')).toThrow()
    expect(() => normalizePhone('+1234567890123456')).toThrow()
  })
})

describe('sticker cards', () => {
  it('one star = one sticker for normal goals', () => {
    expect(cardState(3, 10)).toEqual({ spots: 10, filled: 3, starsPerSpot: 1, full: false, remaining: 7 })
    expect(cardState(12, 10)).toMatchObject({ filled: 10, full: true, remaining: 0 })
  })
  it('big goals still fit on one card', () => {
    const s = cardState(45, 100)
    expect(s.spots).toBeLessThanOrEqual(MAX_SPOTS)
    expect(s.starsPerSpot).toBe(4)
    expect(s.filled).toBe(11)
    expect(s.full).toBe(false)
  })
  it('handles zero and negative balances', () => {
    expect(cardState(0, 5).filled).toBe(0)
    expect(cardState(-3, 5).filled).toBe(0)
  })
  it('picks the same sticker for the same spot every time', () => {
    expect(stickerFor('kid-1', 4)).toBe(stickerFor('kid-1', 4))
  })
})

describe('calendar feed links', () => {
  it('rewrites webcal:// and webcals:// to https://', () => {
    expect(normalizeFeedUrl('webcal://p52-caldav.icloud.com/published/2/abc')).toBe(
      'https://p52-caldav.icloud.com/published/2/abc'
    )
    expect(normalizeFeedUrl(' WEBCALS://outlook.office365.com/owa/calendar/x/calendar.ics ')).toBe(
      'https://outlook.office365.com/owa/calendar/x/calendar.ics'
    )
    expect(normalizeFeedUrl('https://example.com/a.ics')).toBe('https://example.com/a.ics')
  })
  it('the ics:add schema accepts webcal and rejects other schemes', () => {
    expect(icsAddSchema.parse({ url: 'webcal://x.com/a.ics', name: 'A', color: '#000000' }).url).toBe(
      'https://x.com/a.ics'
    )
    expect(() => icsAddSchema.parse({ url: 'ftp://x.com/a.ics', name: 'A', color: '#000000' })).toThrow()
  })
})

describe('photo and contact validation', () => {
  it('accepts small image data URLs and rejects anything else', () => {
    const ok = personUpdateSchema.safeParse({ id: 'p', photo: 'data:image/jpeg;base64,/9j/4AAQ' })
    expect(ok.success).toBe(true)
    expect(personUpdateSchema.safeParse({ id: 'p', photo: 'javascript:alert(1)' }).success).toBe(false)
    expect(personUpdateSchema.safeParse({ id: 'p', photo: 'data:text/html;base64,PGI+' }).success).toBe(false)
    expect(personUpdateSchema.safeParse({ id: 'p', photo: null }).success).toBe(true)
  })
  it('validates contact phone numbers', () => {
    expect(contactCreateSchema.safeParse({ name: 'Grandma', phone: '+1 555 123 4567', color: '#46A758' }).success).toBe(true)
    expect(contactCreateSchema.safeParse({ name: 'Grandma', phone: 'call me', color: '#46A758' }).success).toBe(false)
  })
})

describe('contacts and person photos (database)', () => {
  it('stores contacts with normalized numbers and soft-deletes them', () => {
    const { db } = openDatabase(':memory:')
    const contacts = createContactsService(db)
    const grandma = contacts.create({ name: 'Grandma', phone: '(555) 123-4567', color: '#46A758', photo: null })
    expect(grandma.phone).toBe('+15551234567')
    contacts.create({ name: 'Grandpa', phone: '555 765 4321', color: '#0091FF' })
    expect(contacts.list().map((c) => c.name)).toEqual(['Grandma', 'Grandpa'])
    contacts.update({ id: grandma.id, name: 'Nana' })
    contacts.remove(grandma.id)
    expect(contacts.list().map((c) => c.name)).toEqual(['Grandpa'])
  })
  it('saves a person photo and sticker goal', () => {
    const { db } = openDatabase(':memory:')
    const people = createPeopleService(db)
    const kid = people.create({ name: 'Ava', color: '#E5484D', role: 'child', photo: 'data:image/jpeg;base64,AAAA' })
    expect(kid.photo).toBe('data:image/jpeg;base64,AAAA')
    expect(kid.goalRewardId).toBeNull()
    const updated = people.update({ id: kid.id, photo: null })
    expect(updated.photo).toBeNull()
  })
})

describe('secret box (server encryption at rest)', () => {
  it('round-trips, uses a persistent key, and reads the legacy plain format', () => {
    const keyPath = join(tempDir(), 'secret.key')
    const box = createFileKeySecretBox(keyPath)
    const enc = box.encrypt('refresh-token-123')
    expect(enc.toString('utf8')).not.toContain('refresh-token-123')
    expect(createFileKeySecretBox(keyPath).decrypt(enc)).toBe('refresh-token-123')
    expect(box.decrypt(Buffer.from('plain:legacy', 'utf8'))).toBe('legacy')
  })
  it('refuses tampered ciphertext', () => {
    const box = createFileKeySecretBox(join(tempDir(), 'secret.key'))
    const enc = box.encrypt('hello')
    enc[enc.length - 1] ^= 0xff
    expect(() => box.decrypt(enc)).toThrow()
  })
})

describe('Google paste-back sign-in', () => {
  it('extracts code and state from a full URL or a bare query', () => {
    expect(parsePastedRedirect('http://127.0.0.1:8421/?state=abc&code=4/0xyz&scope=x')).toEqual({
      code: '4/0xyz',
      state: 'abc'
    })
    expect(parsePastedRedirect('?code=c1&state=s1')).toEqual({ code: 'c1', state: 's1' })
  })
  it('reports a denied consent and a missing code', () => {
    expect(() => parsePastedRedirect('http://127.0.0.1:8421/?error=access_denied')).toThrow(/access_denied/)
    expect(() => parsePastedRedirect('http://127.0.0.1:8421/')).toThrow(/code=/)
  })
})

describe('iCloud shared album', () => {
  it('parses the token from a share link', () => {
    expect(parseAlbumToken('https://www.icloud.com/sharedalbum/#B0aGWZuqDGrKMf')).toBe('B0aGWZuqDGrKMf')
    expect(parseAlbumToken('B0aGWZuqDGrKMf')).toBe('B0aGWZuqDGrKMf')
    expect(() => parseAlbumToken('https://www.icloud.com/sharedalbum/')).toThrow()
  })
  it('derives the shard host from the token', () => {
    // 'B' tokens use chars 1-2 as base62: '0a' → 0*62 + 36 = 36
    expect(albumBaseUrl('B0aGWZuqDGrKMf')).toBe('https://p36-sharedstreams.icloud.com/B0aGWZuqDGrKMf/sharedstreams/')
    expect(albumBaseUrl('A5bcdefghijkl')).toBe('https://p05-sharedstreams.icloud.com/A5bcdefghijkl/sharedstreams/')
    expect(albumBaseUrl('Bxyz', 'p99-sharedstreams.icloud.com')).toBe(
      'https://p99-sharedstreams.icloud.com/Bxyz/sharedstreams/'
    )
  })
  it('picks the largest derivative up to 2048px, skips videos, newest first', () => {
    const { name, photos } = pickPhotos({
      streamName: 'Family',
      photos: [
        {
          photoGuid: 'old',
          dateCreated: '2026-01-01T00:00:00Z',
          derivatives: { a: { checksum: 'old-s', width: '342' }, b: { checksum: 'old-l', width: '2048' } }
        },
        { photoGuid: 'vid', mediaAssetType: 'video', derivatives: { a: { checksum: 'v', width: '640' } } },
        {
          photoGuid: 'new',
          dateCreated: '2026-06-01T00:00:00Z',
          derivatives: { a: { checksum: 'new-s', width: '342' }, b: { checksum: 'new-xl', width: '4032' } }
        }
      ]
    })
    expect(name).toBe('Family')
    expect(photos).toEqual([
      { guid: 'new', checksum: 'new-s', createdAt: '2026-06-01T00:00:00Z' },
      { guid: 'old', checksum: 'old-l', createdAt: '2026-01-01T00:00:00Z' }
    ])
  })
  it('maps asset URLs by checksum', () => {
    const urls = assetUrls({ items: { c1: { url_location: 'cvws.icloud-content.com', url_path: '/B/abc?x=1' } } })
    expect(urls.get('c1')).toBe('https://cvws.icloud-content.com/B/abc?x=1')
  })

  it('syncs: follows the shard redirect, downloads new photos, prunes removed ones', async () => {
    const cacheDir = tempDir()
    let albumPhotos = ['g1', 'g2']
    const calls: string[] = []
    const fetcher: Fetcher = async (url, init) => {
      calls.push(url)
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (url.startsWith('https://p36-sharedstreams.icloud.com')) {
        return new Response(JSON.stringify({ 'X-Apple-MMe-Host': 'p42-sharedstreams.icloud.com' }), { status: 330 })
      }
      if (url.endsWith('/webstream')) {
        return Response.json({
          streamName: 'Family',
          photos: albumPhotos.map((g) => ({
            photoGuid: g,
            dateCreated: `2026-0${g.slice(1)}-01T00:00:00Z`,
            derivatives: { x: { checksum: `ck-${g}`, width: '1024' } }
          }))
        })
      }
      if (url.endsWith('/webasseturls')) {
        const items: Record<string, unknown> = {}
        for (const g of body.photoGuids as string[]) items[`ck-${g}`] = { url_location: 'cdn.test', url_path: `/${g}.jpg` }
        return Response.json({ items })
      }
      if (url.startsWith('https://cdn.test/')) return new Response(new Uint8Array([0xff, 0xd8, 0xff]))
      return new Response('nope', { status: 500 })
    }
    const pushes: unknown[] = []
    const album = createAlbumService({
      settings: { getAll: () => ({ album: { url: 'https://www.icloud.com/sharedalbum/#B0aGWZuqDGrKMf' } }) as never },
      cacheDir,
      broadcast: (_ch, p) => pushes.push(p),
      fetcher
    })
    await album.refresh()
    expect(album.getStatus()).toMatchObject({ name: 'Family', photoCount: 2, lastError: null })
    expect(album.listFiles()).toEqual(['g2.jpg', 'g1.jpg']) // newest first
    expect(calls.some((u) => u.startsWith('https://p42-sharedstreams.icloud.com'))).toBe(true)
    expect(pushes).toContainEqual({ domain: 'photos' })

    albumPhotos = ['g2']
    calls.length = 0
    await album.refresh()
    expect(readdirSync(cacheDir).sort()).toEqual(['g2.jpg'])
    expect(calls.some((u) => u.startsWith('https://cdn.test/'))).toBe(false) // nothing re-downloaded
  })

  it('reports a friendly error when the album is not public', async () => {
    const album = createAlbumService({
      settings: { getAll: () => ({ album: { url: 'https://www.icloud.com/sharedalbum/#B0aGWZuqDGrKMf' } }) as never },
      cacheDir: tempDir(),
      broadcast: () => undefined,
      fetcher: async () => new Response('', { status: 404 })
    })
    await album.refresh()
    expect(album.getStatus().lastError).toMatch(/Public Website/)
  })
})

describe('Google Home cameras tile', () => {
  it('launches the Google Home app with a website fallback', () => {
    const link = buildGoogleHomeLink('app')
    expect(link.startsWith('intent:#Intent;')).toBe(true)
    expect(link).toContain(`package=${GOOGLE_HOME_PACKAGE};`)
    expect(link).toContain('S.browser_fallback_url=https%3A%2F%2Fhome.google.com%2F;')
    expect(link.endsWith(';end')).toBe(true)
  })
  it('opens the website when chosen', () => {
    expect(buildGoogleHomeLink('web')).toBe('https://home.google.com/')
  })
  it('asks for the PIN only when needed, and fails closed while loading', () => {
    expect(needsPinForCameras(true, { pinSet: true, unlocked: false })).toBe(true)
    expect(needsPinForCameras(true, { pinSet: true, unlocked: true })).toBe(false)
    expect(needsPinForCameras(true, { pinSet: false, unlocked: false })).toBe(false)
    expect(needsPinForCameras(false, { pinSet: true, unlocked: false })).toBe(false)
    expect(needsPinForCameras(true, undefined)).toBe(true)
  })
})
