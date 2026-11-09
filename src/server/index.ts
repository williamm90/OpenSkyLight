import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { compose } from '../main/composition'
import { broadcast } from '../main/bus'
import { dispatch } from '../main/ipc/router'
import { createFileKeySecretBox } from '../main/secretBox'
import { httpBirdImageUrl } from '../main/services/birdnetService'
import { pickLanAddresses } from '../main/companion/lanAddress'
import { createDisplayAuth } from './displayAuth'
import { createServerKiosk, type ServerKiosk } from './serverKiosk'
import { createHttpServer } from './httpServer'

declare const __OSL_VERSION__: string

/**
 * Headless home server: runs every OpenSkyLight service without Electron and
 * serves the display UI to browsers (the wall tablet runs Fully Kiosk Browser
 * pointed here). Configure with environment variables:
 *   OSL_DATA_DIR  where the database, secret key and photo cache live (./data)
 *   OSL_PORT      display port (8080)
 *   OSL_HOST      bind address (0.0.0.0)
 */
const dataDir = resolve(process.env.OSL_DATA_DIR ?? 'data')
const port = Number(process.env.OSL_PORT ?? 8080)
const host = process.env.OSL_HOST ?? '0.0.0.0'
const version = typeof __OSL_VERSION__ === 'string' ? __OSL_VERSION__ : 'dev'

mkdirSync(dataDir, { recursive: true })
const albumCacheDir = join(dataDir, 'album-cache')
mkdirSync(albumCacheDir, { recursive: true })

let kiosk: ServerKiosk | null = null
let displayAuth: ReturnType<typeof createDisplayAuth> | null = null

const app = compose({
  dataDir,
  appInfo: { version, mode: 'server' },
  secrets: createFileKeySecretBox(join(dataDir, 'secret.key')),
  camera: { wsMode: 'attached' },
  birdImageUrl: httpBirdImageUrl,
  makeKiosk: (settings) => {
    kiosk = createServerKiosk({ settings, broadcast })
    return kiosk
  },
  updater: { start: () => undefined, quitAndInstall: () => undefined },
  companionStaticRoot: join(__dirname, '../companion'),
  albumCacheDir,
  albumPhotoUrl: (name) => `/media/album/${encodeURIComponent(name)}`,
  makeDisplayPairing: (settings) => {
    displayAuth = createDisplayAuth(settings)
    return displayAuth
  }
})

const auth = displayAuth!
const server = createHttpServer({
  displayAuth: auth,
  dispatch: (channel, payload) => dispatch(app.services, app.table, channel, payload, { gate: 'pin' }),
  rendererRoot: join(__dirname, '../renderer'),
  photoFolder: () => app.services.settings.getAll().screensaver.folder,
  albumCacheDir,
  acceptCameraSocket: (ws, req) => app.services.camera.acceptClient(ws, req),
  initialPushes: () => [{ channel: 'push:sleepState', payload: kiosk!.currentState() }],
  version
})

server.listen(port, host, () => {
  app.start()
  const urls = pickLanAddresses().map((ip) => `http://${ip}:${port}/`)
  console.log(`\n  OpenSkyLight ${version} home server`)
  console.log(`  Data: ${dataDir}`)
  console.log(`  Open on your tablet: ${urls[0] ?? `http://localhost:${port}/`}`)
  for (const extra of urls.slice(1)) console.log(`                       ${extra}`)
  if (auth.pairedCount() === 0) {
    const { code } = auth.issueCode()
    console.log(`\n  ┌─────────────────────────────────┐`)
    console.log(`  │  Screen pairing code:  ${code}   │`)
    console.log(`  └─────────────────────────────────┘`)
    console.log('  (valid 15 minutes — restart the server for a new one)\n')
  }
})

function shutdown(): void {
  console.log('[server] shutting down')
  app.shutdown()
  server.close()
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
