import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'node:fs'
import { compose } from './composition'
import { registerIpcHandlers } from './ipc/electronIpc'
import { broadcast } from './bus'
import { createMainWindow } from './window'
import { createKiosk } from './kiosk/kiosk'
import { createUpdater } from './updater'
import { createSafeStorageSecretBox } from './secretBox'
import { electronBirdImageUrl } from './services/birdnetService'

// Test harnesses point this at a temp dir so smoke runs never touch real data
if (process.env.OSL_USER_DATA) {
  app.setPath('userData', process.env.OSL_USER_DATA)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    const dataDir = app.getPath('userData')
    const albumCacheDir = join(dataDir, 'album-cache')
    mkdirSync(albumCacheDir, { recursive: true })

    const app$ = compose({
      dataDir,
      appInfo: { version: app.getVersion(), mode: 'desktop' },
      secrets: createSafeStorageSecretBox(safeStorage),
      camera: { isPackaged: app.isPackaged, wsMode: 'standalone' },
      birdImageUrl: electronBirdImageUrl,
      makeKiosk: (settings) => createKiosk({ settings, broadcast, albumCacheDir }),
      updater: createUpdater({ broadcast }),
      openExternal: (url) => void shell.openExternal(url),
      companionStaticRoot: join(__dirname, '../companion'),
      albumCacheDir,
      albumPhotoUrl: (name) => `osl-album://photos/${encodeURIComponent(name)}`
    })
    app.on('will-quit', () => app$.shutdown())

    registerIpcHandlers(app$.services, app$.table)
    createMainWindow()
    app$.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  // A wall display should restart its UI if the renderer ever crashes
  app.on('render-process-gone', (_event, _webContents, details) => {
    console.error('[main] renderer gone:', details.reason)
    if (details.reason !== 'clean-exit') {
      for (const win of BrowserWindow.getAllWindows()) win.destroy()
      createMainWindow()
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
