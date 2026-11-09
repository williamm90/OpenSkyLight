import { join } from 'node:path'
import { DateTime } from 'luxon'
import { openDatabase, type AppDb } from './db/client'
import { createSettingsService, type SettingsService } from './services/settingsService'
import { createPeopleService } from './services/peopleService'
import { createCalendarService } from './services/calendarService'
import { createEventService } from './services/eventService'
import {
  buildChannelTable,
  dispatch,
  broadcast,
  type AppInfo,
  type ChannelTable,
  type DisplayPairingApi,
  type KioskApi,
  type Services,
  type UpdaterApi
} from './ipc/router'
import { createCompanionTokens } from './companion/companionTokens'
import { createCompanionServer } from './companion/companionServer'
import { createWeatherService } from './services/weatherService'
import { createAuthService } from './services/authService'
import { createChoresService } from './services/choresService'
import { createRewardsService } from './services/rewardsService'
import { createListsService } from './services/listsService'
import { createMealsService } from './services/mealsService'
import { createRssService } from './services/rssService'
import { createCameraService, type CameraServiceDeps } from './services/cameraService'
import { createBirdNetService, type BirdImageUrl } from './services/birdnetService'
import { createContactsService } from './services/contactsService'
import { createAlbumService } from './services/albumService'
import { createNestService } from './services/nestService'
import { createGoogleAuth } from './sync/googleAuth'
import { createGoogleSync } from './sync/googleSync'
import { createOutboxWorker } from './sync/outboxWorker'
import { createIcsSync } from './sync/icsSync'
import { createSyncManager } from './sync/scheduler'
import type { SecretBox } from './secretBox'

export interface CompositionOptions {
  dataDir: string
  appInfo: AppInfo
  secrets: SecretBox
  camera: Omit<CameraServiceDeps, 'secrets'>
  birdImageUrl: BirdImageUrl
  /** Built once settings exist (the Electron kiosk needs them). */
  makeKiosk: (settings: SettingsService) => KioskApi & { start(): void }
  updater: UpdaterApi & { start(): void }
  openExternal?: (url: string) => void
  /** Directory holding the built companion web app. */
  companionStaticRoot: string
  /** Where cached album photos are written (served by the runtime). */
  albumCacheDir: string
  /** Maps a cached album file name to a URL this runtime serves it at. */
  albumPhotoUrl: (fileName: string) => string
  /** Server mode only: screen pairing, built once settings exist. */
  makeDisplayPairing?: (settings: SettingsService) => DisplayPairingApi
}

export interface Composition {
  db: AppDb
  services: Services
  table: ChannelTable
  /** Start background work (sync, kiosk timers, updater, companion, album). */
  start(): void
  shutdown(): void
}

export function compose(opts: CompositionOptions): Composition {
  const { db } = openDatabase(join(opts.dataDir, 'openskylight.db'))
  const deviceTz = (): string => DateTime.local().zoneName ?? 'UTC'

  const settings = createSettingsService(db)
  const kiosk = opts.makeKiosk(settings)
  const cameraService = createCameraService(settings, { ...opts.camera, secrets: opts.secrets })
  const choresService = createChoresService(db, deviceTz)
  const googleAuth = createGoogleAuth(db, settings, { secrets: opts.secrets, openExternal: opts.openExternal })
  const googleSync = createGoogleSync({ db, auth: googleAuth, deviceTz })
  const outbox = createOutboxWorker({
    db,
    sync: googleSync,
    onConflict: (title) => broadcast('push:syncConflict', { title })
  })
  const icsSync = createIcsSync({ db, deviceTz })
  const syncManager = createSyncManager({
    db,
    auth: googleAuth,
    google: googleSync,
    outbox,
    ics: icsSync,
    broadcast
  })
  const album = createAlbumService({ settings, cacheDir: opts.albumCacheDir, broadcast })

  // companion dispatches through the same channel table built below; the
  // closure resolves after boot, before any HTTP request can arrive
  let table: ChannelTable
  const companion = createCompanionServer({
    settings,
    tokens: createCompanionTokens(settings),
    dispatch: (channel, payload) => dispatch(services, table, channel, payload, { gate: 'none' }),
    version: opts.appInfo.version,
    staticRoot: opts.companionStaticRoot
  })

  const services: Services = {
    appInfo: opts.appInfo,
    settings,
    people: createPeopleService(db),
    calendars: createCalendarService(db),
    events: createEventService(db),
    googleAuth,
    googleSync,
    icsSync,
    syncManager,
    weather: createWeatherService(settings),
    auth: createAuthService(settings),
    chores: choresService,
    rewards: createRewardsService(db, choresService),
    lists: createListsService(db),
    meals: createMealsService(db),
    contacts: createContactsService(db),
    album,
    nest: createNestService({ settings, secrets: opts.secrets }),
    albumPhotoUrl: opts.albumPhotoUrl,
    displayPairing: opts.makeDisplayPairing?.(settings),
    kiosk,
    updater: opts.updater,
    rss: createRssService(),
    camera: cameraService,
    birdnet: createBirdNetService(opts.birdImageUrl),
    companion
  }
  table = buildChannelTable(services)

  return {
    db,
    services,
    table,
    start() {
      syncManager.start()
      kiosk.start()
      opts.updater.start()
      companion.applySettings()
      album.start()
    },
    shutdown() {
      cameraService.shutdown()
      companion.shutdown()
      album.stop()
    }
  }
}
