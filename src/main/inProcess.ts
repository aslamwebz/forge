import { ipcMain } from 'electron'
import { createEngine } from './engine'
import { electronPort, type ForgeHost } from './electronPort'
import { setPort } from './host'

/** The Forge's engine in the app's own process: one door for the page, the engine behind it. */
export function mountForge(host: ForgeHost): void {
  setPort(electronPort(host))
  const engine = createEngine()
  ipcMain.handle('freya:forge', async (event, input: unknown) => {
    if (event.sender !== host.window()?.webContents) return { ok: false, error: 'not this window' }
    if ((input as { op?: unknown } | null)?.op === 'restart-forge') return { ok: false, error: 'The Forge restarts on its own only when it runs in its own process.' }
    return engine.handle(input)
  })
}

export { shutdownEngine as shutdownForge } from './shutdown'
