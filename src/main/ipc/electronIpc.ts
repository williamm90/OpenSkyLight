import { BrowserWindow, ipcMain } from 'electron'
import { subscribe } from '../bus'
import { dispatch, type ChannelTable, type Services } from './router'

/** Desktop runtime: every channel through ipcMain, every push to every window. */
export function registerIpcHandlers(services: Services, table: ChannelTable): void {
  for (const channel of table.keys()) {
    ipcMain.handle(channel, (_event, payload) => dispatch(services, table, channel, payload, { gate: 'pin' }))
  }
  subscribe((channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload)
    }
  })
}
