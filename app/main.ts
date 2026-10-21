import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { mountForge, shutdownForge } from '../src/main'

/**
 * The Forge on its own: one window, the Forge in it. Its data lives in its own folder, apart from
 * any app that carries it. There is no security core here, so the lead's tools stay off.
 */

app.setName('Forge')
// FORGE_DATA_DIR gives a run a data folder of its own (a test, a second copy); otherwise the usual one.
app.setPath('userData', process.env.FORGE_DATA_DIR || join(app.getPath('appData'), 'Forge'))
let window: BrowserWindow | null = null

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus() } })

void app.whenReady().then(() => {
  mountForge({ window: () => window, navigate: () => { window?.show(); window?.focus() } })
  window = new BrowserWindow({
    width: 1500, height: 940, minWidth: 900, minHeight: 600, title: 'Forge', backgroundColor: '#1c1714',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  window.setMenuBarVisibility(false)
  // Links never open inside the Forge's own window.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => { event.preventDefault() })
  window.on('closed', () => { window = null })
  void window.loadFile(join(__dirname, 'renderer', 'index.html'))
})

app.on('window-all-closed', () => { app.quit() })
app.on('will-quit', () => { shutdownForge() })
