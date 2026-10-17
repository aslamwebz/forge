import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/** The Forge page's bridge to its main process: one call, and what it hears back. */
const listen = <T>(channel: string, accept: (value: unknown) => T | null) => (handler: (value: T) => void) => {
  const listener = (_event: IpcRendererEvent, value: unknown) => { const accepted = accept(value); if (accepted !== null) handler(accepted) }
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

contextBridge.exposeInMainWorld('forgeBridge', {
  forge: (request: Record<string, unknown>) => ipcRenderer.invoke('freya:forge', request),
  onForgeEvent: listen('freya:forge:event', (value) => {
    const row = (value ?? {}) as { directory?: unknown; event?: { type?: unknown; properties?: unknown } }
    return typeof row.directory === 'string' && typeof row.event?.type === 'string' ? { directory: row.directory, event: { type: row.event.type, properties: row.event.properties } } : null
  }),
  onForgeState: listen('freya:forge:state', (value) => {
    const row = (value ?? {}) as { directory?: unknown; running?: unknown }
    return typeof row.directory === 'string' && typeof row.running === 'number' ? { directory: row.directory, running: row.running } : null
  }),
  onForgeTerminal: listen('freya:forge:term', (value) => {
    const row = (value ?? {}) as { id?: unknown; data?: unknown; exit?: unknown }
    return typeof row.id === 'string' ? { id: row.id, ...(typeof row.data === 'string' ? { data: row.data } : {}), ...(typeof row.exit === 'number' ? { exit: row.exit } : {}) } : null
  }),
})
