import { app, BrowserWindow, ipcMain } from 'electron'
import { release } from 'node:os'
import { join } from 'node:path'
import { mountForgeProcess } from '../src/main'

/**
 * The Forge on its own: one window, the Forge in it. Its data lives in its own folder, apart from
 * any app that carries it. There is no security core here, so the lead's tools stay off. Its engine
 * outlives the window: closing the Forge leaves the agents working, and opening it shows them again.
 */

app.setName('Forge')
// FORGE_DATA_DIR gives a run a data folder of its own (a test, a second copy); otherwise the usual one.
app.setPath('userData', process.env.FORGE_DATA_DIR || join(app.getPath('appData'), 'Forge'))
let window: BrowserWindow | null = null
let forge: { stop: () => Promise<void> } | null = null

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus() } })

void app.whenReady().then(() => {
  forge = mountForgeProcess({ window: () => window, navigate: () => { window?.show(); window?.focus() }, workerPath: join(__dirname, 'worker.cjs'), daemonPath: join(__dirname, 'daemon.cjs') })
  window = new BrowserWindow({
    width: 1500, height: 940, minWidth: 900, minHeight: 600, title: 'Forge', backgroundColor: '#1c1714',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  window.setMenuBarVisibility(false)
  // Links never open inside the Forge's own window.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => { event.preventDefault() })
  window.on('closed', () => { window = null })
  // Glass: the system's acrylic behind the page, on Windows 11 (build 22621 and later); elsewhere the page draws its own.
  ipcMain.handle('forge:window-glass', (event, on: unknown) => {
    if (!window || event.sender !== window.webContents) return false
    const native = process.platform === 'win32' && Number(release().split('.')[2] ?? 0) >= 22621
    if (!native) return false
    window.setBackgroundMaterial(on === true ? 'acrylic' : 'none')
    window.setBackgroundColor(on === true ? '#00000000' : '#1c1714')
    return on === true
  })
  void window.loadFile(join(__dirname, 'renderer', 'index.html'))
})

app.on('window-all-closed', () => { app.quit() })
// Only lets go of the engine: what runs in it keeps running.
app.on('will-quit', () => { void forge?.stop() })
