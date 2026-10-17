import { app, dialog, Notification, shell, type BrowserWindow } from 'electron'
import type { ForgeNotice, ForgePort, ForgeSecurity } from './host'

/** What an Electron app gives the Forge: its window, optionally a security core, and the way back to the Forge page. */
export interface ForgeHost {
  readonly window: () => BrowserWindow | null
  readonly security?: ForgeSecurity
  /** Bring the Forge page to the front (a notice he clicked). */
  readonly navigate?: () => void
}

/** A message for the Forge page in the host's window. */
export function sender(host: ForgeHost): (channel: string, value: unknown) => void {
  return (channel, value) => {
    const target = host.window()
    if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) target.webContents.send(channel, value)
  }
}

/** A notice about an agent, unless he is looking at the app already; a click brings that agent forward. */
export function showNotice(host: ForgeHost, notice: ForgeNotice): void {
  const window = host.window()
  if (!Notification.isSupported() || (window?.isFocused() ?? false)) return
  const toast = new Notification({ title: notice.title, body: notice.body, silent: notice.silent })
  toast.on('click', () => {
    const shown = host.window()
    if (!shown || shown.isDestroyed()) return
    if (shown.isMinimized()) shown.restore()
    shown.show()
    shown.focus()
    host.navigate?.()
    sender(host)('freya:forge:event', { directory: notice.directory, event: { type: 'focus-pane', properties: { key: notice.key } } })
  })
  toast.show()
}

export async function pickFolder(host: ForgeHost, title: string, create: boolean): Promise<string | null> {
  const options = { title, properties: ['openDirectory' as const, ...(create ? ['createDirectory' as const] : [])] }
  const window = host.window()
  const chosen = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return chosen.canceled ? null : chosen.filePaths[0] ?? null
}

/** The engine's port, served by Electron in this process. */
export function electronPort(host: ForgeHost): ForgePort {
  return {
    dataDir: app.getPath('userData'),
    documentsDir: app.getPath('documents'),
    push: sender(host),
    pickFolder: (title, create) => pickFolder(host, title, create),
    openExternal: url => shell.openExternal(url),
    notify: notice => { showNotice(host, notice) },
    ...(host.security ? { security: host.security } : {}),
  }
}
